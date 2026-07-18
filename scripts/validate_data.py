#!/usr/bin/env python3
"""Independent validator for the STACKS ATLAS data pipeline.

Re-parses the Stacks repository from scratch (no import of build_data),
recomputes nodes / dependency edges / cycle breaks / heights, and compares
against public/data/graph.json + meta.json.  Also samples 20 tags with
random seed 123 and re-checks their out-edge sets, and verifies the
per-chapter content files.

Exit code 0 + PASS summary when everything matches; non-zero otherwise.
"""

import json
import os
import random
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.path.join(SCRIPT_DIR, "_upstream")
DATA_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, os.pardir, "public", "data"))

ENV_KINDS = {
    "definition", "lemma", "proposition", "theorem",
    "remark", "example", "exercise", "situation",
}

# fresh implementation: own token scanner
TOK = re.compile(
    r"\\(begin|end)\{([A-Za-z*]+)\}|\\label\{([^}]*)\}|\\section\{")
REF = re.compile(r"\\(?:eqref|ref)\{([^}]*)\}")
CMT = re.compile(r"((?:^|[^\\])(?:\\\\)*)(%[^\n]*)", re.M)


def strip_comments_keep_offsets(text):
    return CMT.sub(lambda m: m.group(1) + " " * len(m.group(2)), text)


def closing_brace(text, i):
    """index of the brace matching text[i]=='{' (backslash-escape aware)"""
    d = 0
    j = i
    while j < len(text):
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            d += 1
        elif c == "}":
            d -= 1
            if d == 0:
                return j
        j += 1
    return -1


def load_tag_map():
    m = {}
    with open(os.path.join(UPSTREAM, "tags", "tags"), encoding="utf8",
              errors="replace") as f:
        for ln in f:
            ln = ln.strip()
            if not ln or ln.startswith("#") or "," not in ln:
                continue
            tag, label = ln.split(",", 1)
            m[label.strip()] = tag.strip()
    return m


def lookup(tagmap, slug, label):
    label = label.strip()
    if not label:
        return None
    return tagmap.get(slug + "-" + label) or tagmap.get(label)


def parse_file(path, slug):
    """Return (items, sections) where items are dicts with
    type/label/statement-mask/proof-mask and sections are (label, title)."""
    with open(path, encoding="utf8", errors="replace") as f:
        text = strip_comments_keep_offsets(f.read())

    stack = []
    done_envs = []   # (kind, label, stmt_span, end_token_end)
    done_proofs = []  # (span, begin_token_start)
    secs = []
    cur_section = ""
    last_sec = None
    for m in TOK.finditer(text):
        be, name, lab = m.group(1), m.group(2), m.group(3)
        if be == "begin":
            stack.append([name, m.end(), m.start(), None, None, cur_section])
        elif be == "end":
            if not stack:
                continue
            rec = stack.pop()
            if rec[0] in ENV_KINDS:
                done_envs.append({
                    "kind": rec[0],
                    "label": rec[3],
                    "label_span": rec[4],
                    "section": rec[5],
                    "span": (rec[1], m.start()),
                    "end": m.end(),
                })
            elif rec[0] == "proof":
                done_proofs.append({"span": (rec[1], m.start()),
                                    "begin": rec[2]})
        elif lab is not None:
            if stack and stack[-1][0] in ENV_KINDS and stack[-1][3] is None:
                stack[-1][3] = lab.strip()
                stack[-1][4] = (m.start(), m.end())
            elif (last_sec is not None and last_sec[1] is None
                    and not any(r[0] in ENV_KINDS for r in stack)
                    and text[last_sec[2]:m.start()].strip() == ""):
                last_sec[1] = lab.strip()
        else:  # \section{
            close = closing_brace(text, m.end() - 1)
            if close < 0:
                continue
            title = text[m.end():close].strip()
            last_sec = [title, None, close + 1]
            secs.append(last_sec)
            cur_section = title

    # proof attachment: first proof following an env with only
    # whitespace/comments in between
    envs_sorted = sorted(done_envs, key=lambda e: e["end"])
    proofs_sorted = sorted(done_proofs, key=lambda p: p["begin"])
    attach = {}
    pi = 0
    for e in envs_sorted:
        while pi < len(proofs_sorted) and proofs_sorted[pi]["begin"] <= e["end"]:
            pi += 1
        if pi < len(proofs_sorted):
            p = proofs_sorted[pi]
            if text[e["end"]:p["begin"]].strip() == "":
                attach[id(e)] = p
                pi += 1

    items = []
    for e in done_envs:
        s0, s1 = e["span"]
        if e["label_span"]:
            a, b = e["label_span"]
            stmt = text[s0:a] + text[b:s1]
        else:
            stmt = text[s0:s1]
        proof_span = attach.get(id(e), {}).get("span")
        proof_txt = text[proof_span[0]:proof_span[1]] if proof_span else ""
        items.append({
            "kind": e["kind"], "label": e["label"],
            "statement": stmt, "proof": proof_txt,
        })
    return items, [(s[1], s[0]) for s in secs]


def recompute():
    tagmap = load_tag_map()
    nodes = {}  # tag -> (kind, chapter, refs)
    for fname in sorted(os.listdir(UPSTREAM)):
        if not fname.endswith(".tex"):
            continue
        slug = fname[:-4].lower()
        items, secs = parse_file(os.path.join(UPSTREAM, fname), slug)
        for it in items:
            if not it["label"]:
                continue
            tag = lookup(tagmap, slug, it["label"])
            if not tag or tag in nodes:
                continue
            refs = set()
            for lab in REF.findall(it["statement"] + "\n" + it["proof"]):
                t = lookup(tagmap, slug, lab)
                if t and t != tag:
                    refs.add(t)
            nodes[tag] = {"kind": it["kind"], "chapter": slug, "refs": refs}
        for lab, _title in secs:
            if not lab:
                continue
            tag = lookup(tagmap, slug, lab)
            if not tag or tag in nodes:
                continue
            nodes[tag] = {"kind": "section", "chapter": slug, "refs": set()}

    tags_sorted = sorted(nodes)
    adj = {t: sorted(v for v in nodes[t]["refs"] if v in nodes and v != t)
           for t in tags_sorted}

    # deterministic DFS back-edge removal
    color = {t: 0 for t in tags_sorted}
    broken = []
    for root in tags_sorted:
        if color[root]:
            continue
        color[root] = 1
        stack = [(root, iter(adj[root]))]
        while stack:
            u, it = stack[-1]
            nxt = False
            for v in it:
                if color[v] == 0:
                    color[v] = 1
                    stack.append((v, iter(adj[v])))
                    nxt = True
                    break
                if color[v] == 1:
                    broken.append((u, v))
            if not nxt:
                color[u] = 2
                stack.pop()
    broken_set = set(broken)
    edges = sorted({(u, v) for u in tags_sorted for v in adj[u]}
                   - broken_set)

    # heights on the DAG
    dag = {t: [v for v in adj[t] if (t, v) not in broken_set]
           for t in tags_sorted}
    height = {}

    def visit(root):
        st = [(root, False)]
        while st:
            u, done = st.pop()
            if done:
                height[u] = 1 + max((height[v] for v in dag[u]), default=-1) \
                    if dag[u] else 0
            else:
                if u in height:
                    continue
                st.append((u, True))
                for v in dag[u]:
                    if v not in height:
                        st.append((v, False))

    for t in tags_sorted:
        if t not in height:
            visit(t)
    return nodes, edges, broken, height


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    with open(os.path.join(DATA_DIR, "meta.json"), encoding="utf8") as f:
        meta = json.load(f)
    with open(os.path.join(DATA_DIR, "graph.json"), encoding="utf8") as f:
        graph = json.load(f)

    nodes, edges, broken, height = recompute()
    gnodes = graph["nodes"]
    gedges = graph["edges"]
    by_tag = {nd["tag"]: nd for nd in gnodes}

    # ---- global counts -------------------------------------------------
    check(len(nodes) == meta["nodeCount"] == len(gnodes),
          "node count: recomputed=%d meta=%d graph=%d"
          % (len(nodes), meta["nodeCount"], len(gnodes)))
    check(len(edges) == meta["edgeCount"] == len(gedges),
          "edge count: recomputed=%d meta=%d graph=%d"
          % (len(edges), meta["edgeCount"], len(gedges)))
    check(set(by_tag) == set(nodes), "tag set mismatch: graph-only=%d recomp-only=%d"
          % (len(set(by_tag) - set(nodes)), len(set(nodes) - set(by_tag))))

    # ---- type counts ----------------------------------------------------
    tc = {}
    for t, nd in nodes.items():
        tc[nd["kind"]] = tc.get(nd["kind"], 0) + 1
    check(tc == meta["typeCounts"],
          "typeCounts: recomputed=%s meta=%s" % (tc, meta["typeCounts"]))

    # ---- heights ---------------------------------------------------------
    mh = max(height.values()) if height else 0
    mh_tag = min((t for t in nodes if height[t] == mh), default=None)
    check(mh == meta["maxHeight"],
          "maxHeight: recomputed=%d meta=%d" % (mh, meta["maxHeight"]))
    check(mh_tag == meta["maxHeightTag"],
          "maxHeightTag: recomputed=%s meta=%s" % (mh_tag, meta["maxHeightTag"]))
    bad_h = [t for t in nodes
             if t in by_tag and by_tag[t]["height"] != height[t]]
    check(not bad_h, "height mismatch for %d nodes e.g. %s"
          % (len(bad_h), bad_h[:5]))

    # ---- per-chapter counts ----------------------------------------------
    chap = {}
    for t, nd in nodes.items():
        chap[nd["chapter"]] = chap.get(nd["chapter"], 0) + 1
    gchap = {c["slug"]: c["nodeCount"] for c in graph["chapters"]}
    check(chap == gchap, "chapter node counts differ: %s"
          % {k: (chap.get(k), gchap.get(k))
             for k in set(chap) | set(gchap) if chap.get(k) != gchap.get(k)})
    check(len(gchap) == meta["chapterCount"],
          "chapterCount: graph=%d meta=%d" % (len(gchap), meta["chapterCount"]))

    # ---- broken cycles -----------------------------------------------------
    recomputed_broken = sorted(broken)
    meta_broken = sorted((b["from"], b["to"]) for b in meta["brokenCycles"])
    check(recomputed_broken == meta_broken,
          "brokenCycles differ: recomputed=%d meta=%d"
          % (len(recomputed_broken), len(meta_broken)))

    # ---- full edge-set equality --------------------------------------------
    index_of = {nd["tag"]: i for i, nd in enumerate(gnodes)}
    graph_edge_tags = {(gnodes[a]["tag"], gnodes[b]["tag"]) for a, b in gedges}
    check(graph_edge_tags == set(edges),
          "edge sets differ: graph-only=%d recomp-only=%d"
          % (len(graph_edge_tags - set(edges)),
             len(set(edges) - graph_edge_tags)))

    # ---- sampled out-edge check (seed 123) ----------------------------------
    broken_from = {}
    for u, v in broken:
        broken_from.setdefault(u, set()).add(v)
    rng = random.Random(123)
    sample = rng.sample(sorted(nodes), min(20, len(nodes)))
    out_edges = {}
    for a, b in gedges:
        out_edges.setdefault(gnodes[a]["tag"], set()).add(gnodes[b]["tag"])
    sample_bad = []
    for tag in sample:
        expected = {v for v in nodes[tag]["refs"] if v in nodes and v != tag}
        expected -= broken_from.get(tag, set())
        actual = out_edges.get(tag, set())
        if expected != actual:
            sample_bad.append((tag, sorted(expected - actual),
                               sorted(actual - expected)))
    check(not sample_bad, "sampled out-edge mismatch: %s" % (sample_bad[:3],))

    # ---- content files -------------------------------------------------------
    content_dir = os.path.join(DATA_DIR, "content")
    missing, empty, bad_entries = [], [], []
    for slug, count in sorted(chap.items()):
        path = os.path.join(content_dir, slug + ".json")
        if not os.path.isfile(path):
            missing.append(slug)
            continue
        if os.path.getsize(path) == 0:
            empty.append(slug)
            continue
        with open(path, encoding="utf8") as f:
            data = json.load(f)
        want = {t for t in nodes if nodes[t]["chapter"] == slug}
        if set(data.get("entries", {})) != want:
            bad_entries.append(slug)
    check(not missing, "missing content files: %s" % missing[:5])
    check(not empty, "empty content files: %s" % empty[:5])
    check(not bad_entries, "content entries mismatch: %s" % bad_entries[:5])

    # ---- positions sanity ------------------------------------------------------
    pos_bad = [nd["tag"] for nd in gnodes
               if not (isinstance(nd.get("pos"), list) and len(nd["pos"]) == 3
                       and all(isinstance(x, (int, float)) for x in nd["pos"]))]
    check(not pos_bad, "bad pos for %d nodes" % len(pos_bad))

    # ---- commit ------------------------------------------------------------------
    try:
        commit = subprocess.check_output(
            ["git", "-C", UPSTREAM, "rev-parse", "HEAD"], text=True).strip()
        check(meta["commit"] == commit and meta["commitShort"] == commit[:7],
              "commit mismatch: meta=%s repo=%s" % (meta["commit"], commit))
    except Exception as exc:  # pragma: no cover
        check(False, "git rev-parse failed: %s" % exc)

    check(meta.get("layoutSeed") == 42, "layoutSeed != 42")

    # ---- report ----------------------------------------------------------------------
    print("nodes=%d edges=%d chapters=%d maxHeight=%d(%s) broken=%d types=%s"
          % (len(nodes), len(edges), len(chap), mh, mh_tag, len(broken), tc))
    if failures:
        print("VALIDATION FAILED (%d):" % len(failures))
        for msg in failures:
            print("  -", msg)
        return 1
    print("PASS: all %d checks ok (incl. %d sampled out-edge sets, seed 123)"
          % (13, len(sample)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
