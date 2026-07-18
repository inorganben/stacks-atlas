#!/usr/bin/env python3
"""STACKS ATLAS offline data pipeline.

Parses the Stacks Project repository (scripts/_upstream, pinned commit),
extracts tagged environments (definition/lemma/proposition/theorem/remark/
example/exercise/situation) plus tagged sections, builds the dependency
graph via \\ref / \\eqref analysis, breaks cycles deterministically, computes
heights (longest path), lays the graph out deterministically (per-chapter
Fruchterman-Reingold in the XZ plane + Archimedean-spiral chapter packing,
height-based Y), and writes:

  public/data/graph.json           nodes / edges / chapters
  public/data/meta.json            stats, commit, broken cycles, seed
  public/data/content/<slug>.json  statements + proofs per chapter

Only stdlib + numpy are used.  All randomness derives from
numpy.random.RandomState(42) or sha1(tag); nothing is time-based except
the meta.json "parsedAt" timestamp.
"""

import datetime
import hashlib
import json
import math
import os
import re
import subprocess
import sys

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = os.path.join(SCRIPT_DIR, "_upstream")
DATA_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, os.pardir, "public", "data"))
CONTENT_DIR = os.path.join(DATA_DIR, "content")

TARGET_ENVS = (
    "definition", "lemma", "proposition", "theorem",
    "remark", "example", "exercise", "situation",
)
TARGET_SET = set(TARGET_ENVS)
LAYOUT_SEED = 42

TOKEN_RE = re.compile(
    r"\\(begin|end)\{([A-Za-z*]+)\}"   # 1: begin/end  2: env name
    r"|\\label\{([^}]*)\}"             # 3: label
    r"|\\section\{"                    # section (brace matched separately)
)
REF_RE = re.compile(r"\\(?:eqref|ref)\{([^}]*)\}")
COMMENT_RE = re.compile(r"((?:^|[^\\])(?:\\\\)*)(%[^\n]*)", re.M)


# --------------------------------------------------------------------------
# low-level text helpers
# --------------------------------------------------------------------------

def mask_comments(text):
    """Blank out (preserve offsets!) every unescaped %-comment."""
    def repl(m):
        return m.group(1) + " " * len(m.group(2))
    return COMMENT_RE.sub(repl, text)


def match_brace(text, i):
    """text[i] == '{'; return index of matching '}' (escape aware) or -1."""
    depth = 0
    j = i
    n = len(text)
    while j < n:
        c = text[j]
        if c == "\\":
            j += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return -1


def first_macro_arg(masked, raw, macro):
    """Return raw argument of the first \\macro{...} occurrence or None."""
    m = re.search(r"\\" + macro + r"\{", masked)
    if not m:
        return None
    close = match_brace(masked, m.end() - 1)
    if close < 0:
        return None
    return raw[m.end():close].strip()


# --------------------------------------------------------------------------
# tags file
# --------------------------------------------------------------------------

def parse_tags(path):
    label2tag = {}
    tag2label = {}
    with open(path, encoding="utf8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "," not in line:
                continue
            tag, label = line.split(",", 1)
            tag = tag.strip()
            label = label.strip()
            if not tag or not label:
                continue
            label2tag[label] = tag
            tag2label[tag] = label
    return label2tag, tag2label


# --------------------------------------------------------------------------
# chapter parser (line-oriented state machine over a comment-masked text;
# offsets in the masked text are identical to the raw text so slices of the
# raw file stay available for statement extraction)
# --------------------------------------------------------------------------

class Chapter:
    def __init__(self, path, slug):
        self.slug = slug
        with open(path, encoding="utf8", errors="replace") as f:
            self.raw = f.read()
        self.masked = mask_comments(self.raw)
        self.envs = []       # completed target envs
        self.proofs = []     # completed proof envs
        self.sections = []   # every \section (label filled in when tagged)
        self.title_chapter = first_macro_arg(self.masked, self.raw, "chapter")
        self.title_doc = first_macro_arg(self.masked, self.raw, "title")
        self.anomalies = []
        self._parse()

    def _parse(self):
        masked = self.masked
        raw = self.raw
        stack = []
        current_section = ""
        pending_section = None
        for m in TOKEN_RE.finditer(masked):
            kind = m.group(1)
            if kind == "begin":
                name = m.group(2)
                stack.append({
                    "name": name,
                    "target": name in TARGET_SET,
                    "start": m.end(),          # just past \begin{...}
                    "begin_start": m.start(),
                    "label": None,
                    "label_span": None,
                    "section": current_section,
                })
            elif kind == "end":
                name = m.group(2)
                if not stack:
                    self.anomalies.append(("end-without-begin", name, m.start()))
                    continue
                rec = stack.pop()
                if rec["name"] != name:
                    self.anomalies.append(
                        ("env-mismatch", rec["name"], name, m.start()))
                if rec["target"]:
                    envs_idx = len(self.envs)
                    self.envs.append({
                        "idx": envs_idx,
                        "type": rec["name"],
                        "label": rec["label"],
                        "label_span": rec["label_span"],
                        "section": rec["section"],
                        "start": rec["start"],
                        "end_start": m.start(),
                        "end_end": m.end(),
                    })
                elif rec["name"] == "proof":
                    self.proofs.append({
                        "start": rec["start"],
                        "end_start": m.start(),
                        "begin_start": rec["begin_start"],
                    })
            elif m.group(3) is not None:  # \label{...}
                lab = m.group(3).strip()
                if stack and stack[-1]["target"] and stack[-1]["label"] is None:
                    stack[-1]["label"] = lab
                    stack[-1]["label_span"] = (m.start(), m.end())
                elif (pending_section is not None
                        and pending_section["label"] is None
                        and not any(r["target"] for r in stack)
                        and masked[pending_section["end"]:m.start()].strip() == ""):
                    pending_section["label"] = lab
            else:  # \section{
                close = match_brace(masked, m.end() - 1)
                if close < 0:
                    self.anomalies.append(("section-brace", None, m.start()))
                    continue
                title = raw[m.end():close].strip()
                sec = {"title": title, "label": None, "end": close + 1}
                self.sections.append(sec)
                pending_section = sec
                current_section = title
        if stack:
            self.anomalies.append(("unclosed", stack[-1]["name"], stack[-1]["start"]))

    def attach_proofs(self):
        """Map env idx -> proof for proofs immediately following the env
        (only whitespace/comments in between)."""
        attached = {}
        envs = sorted(self.envs, key=lambda e: e["end_end"])
        proofs = sorted(self.proofs, key=lambda p: p["begin_start"])
        pi = 0
        np_ = len(proofs)
        for e in envs:
            while pi < np_ and proofs[pi]["begin_start"] <= e["end_end"]:
                pi += 1
            if pi < np_:
                p = proofs[pi]
                if self.masked[e["end_end"]:p["begin_start"]].strip() == "":
                    attached[e["idx"]] = p
                    pi += 1
        return attached

    def resolve(self, label2tag, lab):
        """Resolve a \\ref/\\label occurring in this chapter to a tag."""
        lab = lab.strip()
        if not lab:
            return None
        tag = label2tag.get(self.slug + "-" + lab)
        if tag is None:
            tag = label2tag.get(lab)
        return tag


# --------------------------------------------------------------------------
# graph helpers
# --------------------------------------------------------------------------

def break_cycles(tags_sorted, adj):
    """Deterministic DFS (sorted nodes / neighbours); remove back edges.
    Returns list of (from, to) broken edges."""
    color = {t: 0 for t in tags_sorted}  # 0 white, 1 gray, 2 black
    broken = []
    for root in tags_sorted:
        if color[root]:
            continue
        color[root] = 1
        stack = [(root, iter(sorted(adj[root])))]
        while stack:
            u, it = stack[-1]
            descended = False
            for v in it:
                if color[v] == 0:
                    color[v] = 1
                    stack.append((v, iter(sorted(adj[v]))))
                    descended = True
                    break
                elif color[v] == 1:
                    broken.append((u, v))
            if not descended:
                color[u] = 2
                stack.pop()
    return broken


def compute_heights(tags_sorted, adj):
    """Longest path heights on a DAG (iterative post-order, memoised)."""
    height = {}

    def visit(root):
        stack = [(root, False)]
        while stack:
            u, processed = stack.pop()
            if processed:
                h = 0
                for v in adj[u]:
                    hv = height[v] + 1
                    if hv > h:
                        h = hv
                height[u] = h
            else:
                if u in height:
                    continue
                stack.append((u, True))
                for v in adj[u]:
                    if v not in height:
                        stack.append((v, False))

    for t in tags_sorted:
        if t not in height:
            visit(t)
    return height


# --------------------------------------------------------------------------
# layout
# --------------------------------------------------------------------------

def tag_jitter(tag):
    seed = int.from_bytes(hashlib.sha1(tag.encode("utf8")).digest()[:8], "big") % (2 ** 32)
    return float(np.random.RandomState(seed).uniform(-0.8, 0.8))


def fruchterman_reingold(tags, heights, edges):
    """Deterministic 2D FR layout for one chapter.

    tags: list of node tags (sorted), heights: np array of node heights,
    edges: (u_idx, v_idx) undirected pairs.  Returns (n,2) positions centred
    on the origin."""
    n = len(tags)
    if n == 1:
        return np.zeros((1, 2))
    rng = np.random.RandomState(LAYOUT_SEED)
    k = 8.0  # k = sqrt(area/n) with area = (sqrt(n)*8)^2
    gravity = 0.05  # keeps disconnected components bounded (standard FR variant)
    pos = np.zeros((n, 2))
    heights = np.asarray(heights)
    uniq = sorted(set(int(x) for x in heights))
    rank = {h: r for r, h in enumerate(uniq)}
    for h in uniq:
        idx = np.where(heights == h)[0]
        r = (rank[h] + 1) * k  # rings of increasing radius by height rank
        ang = 2.0 * np.pi * np.arange(len(idx)) / len(idx)
        pos[idx, 0] = r * np.cos(ang)
        pos[idx, 1] = r * np.sin(ang)
    pos += rng.uniform(-0.3, 0.3, size=(n, 2))

    eu = np.array([a for a, _ in edges], dtype=np.int64) if edges else None
    ev = np.array([b for _, b in edges], dtype=np.int64) if edges else None

    iterations = 300
    t0 = 3.0 * k
    for it in range(iterations):
        temp = t0 * (1.0 - it / iterations)
        delta = pos[:, None, :] - pos[None, :, :]        # (n,n,2)
        d2 = np.einsum("ijk,ijk->ij", delta, delta)      # squared dist
        np.fill_diagonal(d2, np.inf)
        coeff = (k * k) / d2                             # repulsive: k^2/d^2
        disp = np.einsum("ijk,ij->ik", delta, coeff)
        if eu is not None and len(eu):
            de = pos[eu] - pos[ev]
            ds = np.sqrt(np.einsum("ij,ij->i", de, de)) + 1e-9
            fa = de * (ds / k)[:, None]                  # attractive: d^2/k
            np.add.at(disp, eu, -fa)
            np.add.at(disp, ev, fa)
        disp -= gravity * k * pos                        # weak central gravity
        norm = np.sqrt(np.einsum("ij,ij->i", disp, disp))
        norm[norm < 1e-9] = 1e-9
        pos += disp * (np.minimum(norm, temp) / norm)[:, None]
    pos -= pos.mean(axis=0)
    return pos


def place_chapters(chapters):
    """Archimedean spiral packing of chapter discs (biggest first)."""
    placed = []  # (cx, cz, radius)
    order = sorted(range(len(chapters)),
                   key=lambda i: (-chapters[i]["nodeCount"], chapters[i]["slug"]))
    for i in order:
        ch = chapters[i]
        theta = len(placed) * 2.399963  # golden angle, i-th placed chapter
        r = 0.0
        while True:
            cx = r * math.cos(theta)
            cz = r * math.sin(theta)
            ok = True
            for (px, pz, pr) in placed:
                d = math.hypot(cx - px, cz - pz)
                if d < ch["radius"] + pr - 1e-9:
                    ok = False
                    break
                if d < max(ch["radius"], pr) * 1.3 - 1e-9:
                    ok = False
                    break
            if ok:
                break
            r += 2.0
        placed.append((cx, cz, ch["radius"]))
        ch["center"] = (cx, cz)


# --------------------------------------------------------------------------
# content rewriting
# --------------------------------------------------------------------------

def rewrite_refs(text, chapter, label2tag):
    def rep(m):
        lab = m.group(1).strip()
        tag = label2tag.get(chapter + "-" + lab) or label2tag.get(lab)
        return "@[" + tag + "]" if tag else "[?]"
    return REF_RE.sub(rep, text)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    t0 = datetime.datetime.now()
    commit = subprocess.check_output(
        ["git", "-C", UPSTREAM, "rev-parse", "HEAD"], text=True).strip()
    label2tag, tag2label = parse_tags(os.path.join(UPSTREAM, "tags", "tags"))
    print("tags:", len(label2tag))

    tex_files = sorted(
        f for f in os.listdir(UPSTREAM)
        if f.endswith(".tex") and os.path.isfile(os.path.join(UPSTREAM, f)))

    nodes = {}          # tag -> node dict
    chapters = {}       # slug -> chapter info
    anomalies = []

    for fname in tex_files:
        slug = fname[:-4].lower()
        ch = Chapter(os.path.join(UPSTREAM, fname), slug)
        for a in ch.anomalies:
            anomalies.append((slug,) + a)
        attached = ch.attach_proofs()
        chapter_tags = []

        # environments ------------------------------------------------
        for env in ch.envs:
            if not env["label"]:
                continue
            tag = ch.resolve(label2tag, env["label"])
            if not tag:
                continue
            if tag in nodes:
                anomalies.append((slug, "duplicate-tag", tag, env["start"]))
                continue
            s0, s1 = env["start"], env["end_start"]
            if env["label_span"]:
                la, lb = env["label_span"]
                statement = (ch.raw[s0:la] + ch.raw[lb:s1]).strip()
                masked_stmt = ch.masked[s0:la] + ch.masked[lb:s1]
            else:
                statement = ch.raw[s0:s1].strip()
                masked_stmt = ch.masked[s0:s1]
            proof = attached.get(env["idx"])
            proof_text = None
            masked_proof = ""
            if proof is not None:
                proof_text = ch.raw[proof["start"]:proof["end_start"]].strip()
                masked_proof = ch.masked[proof["start"]:proof["end_start"]]
            refs = set()
            for lab in REF_RE.findall(masked_stmt):
                t = ch.resolve(label2tag, lab)
                if t and t != tag:
                    refs.add(t)
            for lab in REF_RE.findall(masked_proof):
                t = ch.resolve(label2tag, lab)
                if t and t != tag:
                    refs.add(t)
            nodes[tag] = {
                "tag": tag, "type": env["type"], "chapter": slug,
                "section": env["section"],
                "statement": statement, "proof": proof_text,
                "refs": refs,
            }
            chapter_tags.append(tag)

        # sections -----------------------------------------------------
        section_nodes = []
        for sec in ch.sections:
            if not sec["label"]:
                continue
            tag = ch.resolve(label2tag, sec["label"])
            if not tag or tag in nodes:
                continue
            nodes[tag] = {
                "tag": tag, "type": "section", "chapter": slug,
                "section": sec["title"],
                "statement": "", "proof": None,
                "refs": set(),
            }
            section_nodes.append((tag, sec["title"]))
            chapter_tags.append(tag)

        if chapter_tags:
            title = (ch.title_chapter or ch.title_doc
                     or (ch.sections[0]["title"] if ch.sections else None)
                     or slug)
            chapters[slug] = {
                "slug": slug,
                "title": title,
                "tags": chapter_tags,
                "section_titles": section_nodes,
            }

    print("chapters with nodes:", len(chapters))
    print("nodes:", len(nodes))
    if anomalies:
        print("anomalies:", len(anomalies), anomalies[:10])

    # ------------------------------------------------------------------
    # dependency edges
    # ------------------------------------------------------------------
    node_set = set(nodes)
    adj = {t: set() for t in nodes}
    for tag, nd in nodes.items():
        for tgt in nd["refs"]:
            if tgt in node_set and tgt != tag:
                adj[tag].add(tgt)
    raw_edges = {(u, v) for u in adj for v in adj[u]}
    print("raw edges:", len(raw_edges))

    tags_sorted = sorted(nodes)
    broken = break_cycles(tags_sorted, adj)
    broken_set = set(broken)
    edges = sorted(raw_edges - broken_set)
    adj_dag = {t: sorted(v for v in adj[t] if (t, v) not in broken_set)
               for t in tags_sorted}
    print("final edges:", len(edges), "broken cycles:", len(broken))

    heights = compute_heights(tags_sorted, adj_dag)
    max_height = max(heights.values()) if heights else 0
    max_height_tag = min(t for t in tags_sorted if heights[t] == max_height)

    indegree = {t: 0 for t in tags_sorted}
    for u, v in edges:
        indegree[v] += 1

    # ------------------------------------------------------------------
    # layout
    # ------------------------------------------------------------------
    for tag in tags_sorted:
        nd = nodes[tag]
        nd["height"] = heights[tag]
        nd["y"] = heights[tag] * 6.0 + tag_jitter(tag)

    chapter_list = []
    for slug in sorted(chapters):
        info = chapters[slug]
        tags = sorted(info["tags"])
        idx = {t: i for i, t in enumerate(tags)}
        hedges = set()
        for t in tags:
            for v in adj_dag[t]:
                if v in idx:
                    a, b = idx[t], idx[v]
                    hedges.add((a, b) if a < b else (b, a))
        hvals = [heights[t] for t in tags]
        pos2 = fruchterman_reingold(tags, hvals, sorted(hedges))
        radius = float(np.sqrt((pos2 ** 2).sum(axis=1)).max()) + 4.0
        chapter_list.append({
            "slug": slug,
            "title": info["title"],
            "nodeCount": len(tags),
            "tags": tags,
            "local": pos2,
            "radius": radius,
        })
        print("  laid out %-28s n=%5d radius=%8.2f" % (slug, len(tags), radius))

    place_chapters(chapter_list)

    pos_of = {}
    chapter_out = []
    for cid, ch in enumerate(chapter_list):
        cx, cz = ch["center"]
        for i, tag in enumerate(ch["tags"]):
            x = cx + float(ch["local"][i, 0])
            z = cz + float(ch["local"][i, 1])
            pos_of[tag] = [round(x, 4), round(nodes[tag]["y"], 4), round(z, 4)]
        chapter_out.append({
            "id": cid,
            "slug": ch["slug"],
            "title": ch["title"],
            "nodeCount": ch["nodeCount"],
            "center": [round(cx, 4), 0.0, round(cz, 4)],
            "radius": round(ch["radius"], 4),
        })

    # ------------------------------------------------------------------
    # graph.json
    # ------------------------------------------------------------------
    index_of = {t: i for i, t in enumerate(tags_sorted)}
    nodes_out = [{
        "tag": t,
        "label": tag2label.get(t, ""),
        "type": nodes[t]["type"],
        "chapter": nodes[t]["chapter"],
        "section": nodes[t]["section"],
        "height": nodes[t]["height"],
        "indegree": indegree[t],
        "pos": pos_of[t],
    } for t in tags_sorted]
    edges_out = [[index_of[u], index_of[v]] for u, v in edges]

    type_counts = {}
    for t in tags_sorted:
        type_counts[nodes[t]["type"]] = type_counts.get(nodes[t]["type"], 0) + 1

    os.makedirs(CONTENT_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "graph.json"), "w", encoding="utf8") as f:
        json.dump({
            "chapters": chapter_out,
            "nodes": nodes_out,
            "edges": edges_out,
        }, f, ensure_ascii=False, separators=(",", ":"))

    # ------------------------------------------------------------------
    # content/*.json
    # ------------------------------------------------------------------
    for ch in chapter_list:
        slug = ch["slug"]
        info = chapters[slug]
        entries = {}
        for tag in info["tags"]:
            nd = nodes[tag]
            stmt = rewrite_refs(nd["statement"], slug, label2tag)
            proof = (rewrite_refs(nd["proof"], slug, label2tag)
                     if nd["proof"] is not None else None)
            entries[tag] = {
                "statement": stmt,
                "proof": proof,
                "section": nd["section"],
            }
        sections_map = {tag: title for tag, title in info["section_titles"]}
        with open(os.path.join(CONTENT_DIR, slug + ".json"), "w", encoding="utf8") as f:
            json.dump({
                "chapter": slug,
                "sections": sections_map,
                "entries": entries,
            }, f, ensure_ascii=False, separators=(",", ":"))

    # ------------------------------------------------------------------
    # meta.json
    # ------------------------------------------------------------------
    meta = {
        "commit": commit,
        "commitShort": commit[:7],
        "parsedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "nodeCount": len(nodes_out),
        "edgeCount": len(edges_out),
        "typeCounts": type_counts,
        "maxHeight": max_height,
        "maxHeightTag": max_height_tag,
        "chapterCount": len(chapter_out),
        "brokenCycles": [{"from": u, "to": v} for u, v in broken],
        "layoutSeed": LAYOUT_SEED,
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))

    dt = (datetime.datetime.now() - t0).total_seconds()
    print("done in %.1fs: nodes=%d edges=%d chapters=%d maxHeight=%d (%s)"
          % (dt, len(nodes_out), len(edges_out), len(chapter_out),
             max_height, max_height_tag))


if __name__ == "__main__":
    main()
