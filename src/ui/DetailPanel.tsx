// 详情侧栏：tag 大标题 + 类型徽章 + 章/节面包屑；定位/加入路径；陈述区块；证明区块（可折叠）；
// 依赖/被引用列表；路径查找（Web Worker BFS）。LaTeX 经 katexRender 管线分段渲染，
// 长内容按段落分片 requestIdleCallback 渲染。
import { useEffect, useMemo, useRef, useState } from 'react'
import { graph, loadChapterContent, shortLabel } from '../data/loader'
import type { ContentEntry } from '../data/types'
import { TYPE_COLORS } from '../data/types'
import { renderParagraph, splitParagraphs } from '../data/katexRender'
import { useAtlas } from '../store'
import type { PathFindMsg, PathInitMsg, PathResultMsg } from '../workers/pathWorker'

const CHUNK_SIZE = 40

/** 长内容分片渲染：每片 ≤40 段，requestIdleCallback 调度，不阻塞交互 */
function ChunkedLatex({ source }: { source: string }) {
  const [chunks, setChunks] = useState<string[]>([])
  useEffect(() => {
    setChunks([])
    const paras = splitParagraphs(source)
    if (paras.length === 0) return
    let cancelled = false
    let idx = 0
    let idleId = 0
    let timerId = 0
    const renderNext = () => {
      if (cancelled) return
      const slice = paras.slice(idx, idx + CHUNK_SIZE)
      idx += CHUNK_SIZE
      const html = slice.map((p) => `<p>${renderParagraph(p)}</p>`).join('')
      setChunks((prev) => [...prev, html])
      if (idx < paras.length) schedule(renderNext)
    }
    const schedule = (cb: () => void) => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => cb(), { timeout: 180 })
      } else {
        timerId = window.setTimeout(cb, 16)
      }
    }
    schedule(renderNext)
    return () => {
      cancelled = true
      if (idleId && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId)
      if (timerId) window.clearTimeout(timerId)
    }
  }, [source])
  return (
    <>
      {chunks.map((h, i) => (
        // 内容来自本地数据管线（LaTeX 源），经 KaTeX renderToString 与 HTML 转义
        <div key={i} className="math-content" dangerouslySetInnerHTML={{ __html: h }} />
      ))}
    </>
  )
}

function TagLinks({ indices, total }: { indices: number[]; total: number }) {
  const rt = graph.current
  const select = useAtlas((s) => s.select)
  const flyTo = useAtlas((s) => s.flyTo)
  if (!rt) return null
  const shown = indices.slice(0, 200)
  return (
    <>
      <div className="dep-list">
        {shown.map((i) => (
          <a
            key={i}
            className="tag-link"
            href={`#${rt.nodes[i].tag}`}
            onClick={(e) => {
              e.preventDefault()
              select(i)
              flyTo('tag', { nodeIndex: i })
            }}
          >
            {rt.nodes[i].tag}
          </a>
        ))}
      </div>
      {total > 200 && <div className="dep-more">… 共 {total} 条（仅显示前 200）</div>}
    </>
  )
}

export function DetailPanel() {
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const selected = useAtlas((s) => s.selected)
  const pathFrom = useAtlas((s) => s.pathFrom)
  const path = useAtlas((s) => s.path)
  const pathStatus = useAtlas((s) => s.pathStatus)
  const select = useAtlas((s) => s.select)
  const flyTo = useAtlas((s) => s.flyTo)
  const setPathFrom = useAtlas((s) => s.setPathFrom)
  const setPath = useAtlas((s) => s.setPath)
  const startTour = useAtlas((s) => s.startTour)

  const [entry, setEntry] = useState<ContentEntry | null>(null)
  const [contentMissing, setContentMissing] = useState(false)
  const [proofOpen, setProofOpen] = useState(false)
  const [pathTarget, setPathTarget] = useState('')
  const workerRef = useRef<Worker | null>(null)
  const reqId = useRef(0)

  const rt = ready ? graph.current : null
  const node = selected != null && rt ? rt.nodes[selected] : null

  // 路径 Worker：创建 + 初始化邻接表
  useEffect(() => {
    const w = new Worker(new URL('../workers/pathWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<PathResultMsg>) => {
      if (e.data.type === 'path' && e.data.id === reqId.current) {
        setPath(e.data.path, e.data.path ? 'found' : 'none')
      }
    }
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [setPath])

  useEffect(() => {
    if (!ready || !rt || !workerRef.current) return
    const msg: PathInitMsg = { type: 'init', n: rt.nodeCount, outStart: rt.outStart, outList: rt.outList }
    workerRef.current.postMessage(msg)
  }, [ready, rt])

  // 选中变化 → 加载章内容
  useEffect(() => {
    setEntry(null)
    setContentMissing(false)
    if (selected == null || !rt) return
    let cancelled = false
    const nd = rt.nodes[selected]
    loadChapterContent(nd.chapter)
      .then((c) => {
        if (cancelled) return
        const e = c.entries[nd.tag] ?? null
        setEntry(e)
        if (e?.proof) setProofOpen(splitParagraphs(e.proof).length <= 60)
      })
      .catch(() => {
        if (!cancelled) setContentMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [selected, rt])

  // 依赖 / 被引用列表
  const { deps, refs } = useMemo(() => {
    if (selected == null || !rt) return { deps: [] as number[], refs: [] as number[] }
    const d: number[] = []
    for (let k = rt.outStart[selected]; k < rt.outStart[selected + 1]; k++) d.push(rt.outList[k])
    const r: number[] = []
    for (let k = rt.inStart[selected]; k < rt.inStart[selected + 1]; k++) r.push(rt.inList[k])
    return { deps: d, refs: r }
  }, [selected, rt])

  const findPath = () => {
    if (!rt || !workerRef.current) return
    const from = pathFrom ?? selected
    const to = rt.tagToIndex.get(pathTarget.trim().toUpperCase())
    if (from == null || to == null) {
      setPath(null, 'none')
      return
    }
    reqId.current++
    setPath(null, 'searching')
    const msg: PathFindMsg = { type: 'find', id: reqId.current, from, to }
    workerRef.current.postMessage(msg)
  }

  // @[TAG] 链接点击委托
  const onContentClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.tag-link') as HTMLAnchorElement | null
    if (!a || !rt) return
    e.preventDefault()
    const tag = a.dataset.tag
    const idx = tag ? rt.tagToIndex.get(tag) : undefined
    if (idx != null) {
      select(idx)
      flyTo('tag', { nodeIndex: idx })
    }
  }

  const open = selected != null && node != null && rt != null
  const chapterTitle = open ? (rt.chapters[rt.nodeChapter[selected]]?.title ?? node.chapter) : ''
  const proofParas = entry?.proof ? splitParagraphs(entry.proof).length : 0

  return (
    <aside id="detail" className={open ? 'open' : ''} aria-hidden={!open}>
      {open && (
        <>
          <button className="btn detail-close" onClick={() => select(null)} aria-label="关闭详情">
            ESC ✕
          </button>
          <div className="detail-head">
            <div className="tagrow">
              <h2 className="entry-title">{shortLabel(node)}</h2>
              <span className="badge" style={{ color: TYPE_COLORS[node.type] }}>
                {node.type}
              </span>
            </div>
            <div className="crumb">
              <span className="tag-dim">{node.tag}</span> · {chapterTitle} · {node.section}
              <br />
              HEIGHT {node.height} · INDEG {node.indegree}
            </div>
            <div className="detail-actions">
              <button className="btn" onClick={() => flyTo('tag', { nodeIndex: selected })} aria-label="定位到条目">
                定位
              </button>
              <button
                className={`btn${pathFrom === selected ? ' active' : ''}`}
                onClick={() => setPathFrom(pathFrom === selected ? null : selected)}
                aria-label="设为或取消路径起点"
              >
                {pathFrom === selected ? '取消起点' : '设为起点'}
              </button>
            </div>
          </div>
          <div className="detail-body" onClick={onContentClick}>
            <div className="detail-sec-title">STATEMENT</div>
            {entry ? (
              <ChunkedLatex source={entry.statement} />
            ) : contentMissing ? (
              <div className="empty-note">内容文件加载失败（data/content/{node.chapter}.json）</div>
            ) : (
              <div className="empty-note">加载中…</div>
            )}
            {entry && !entry.statement.trim() && <div className="empty-note">该条目暂无论述文本</div>}

            {entry?.proof && (
              <>
                <div className="detail-sec-title">PROOF</div>
                <button
                  className="proof-toggle"
                  onClick={() => setProofOpen((v) => !v)}
                  aria-expanded={proofOpen}
                >
                  {proofOpen ? '▾ 收起证明' : '▸ 展开证明'} · {proofParas} 段
                </button>
                {proofOpen && <ChunkedLatex source={entry.proof} />}
              </>
            )}
            {entry && !entry.proof && (
              <>
                <div className="detail-sec-title">PROOF</div>
                <div className="empty-note">该条目暂无证明文本</div>
              </>
            )}

            <div className="detail-sec-title">依赖 ({deps.length})</div>
            <TagLinks indices={deps} total={deps.length} />

            <div className="detail-sec-title">被引用 ({refs.length})</div>
            <TagLinks indices={refs} total={refs.length} />

            <div className="detail-sec-title">PATH FINDING</div>
            <div className="path-box">
              <input
                value={pathTarget}
                placeholder="目标 TAG（如 015I）"
                aria-label="路径目标 tag"
                spellCheck={false}
                onChange={(e) => setPathTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') findPath()
                }}
              />
              <div className="detail-actions" style={{ marginTop: 8 }}>
                <button className="btn" onClick={findPath} aria-label="查找最短依赖路径">
                  FIND PATH
                </button>
                {pathStatus === 'found' && path && (
                  <button className="btn" onClick={() => startTour(path, 'PATH')} aria-label="沿路径飞行">
                    FLY PATH
                  </button>
                )}
                {(pathFrom != null || path != null) && (
                  <button
                    className="btn"
                    onClick={() => {
                      setPathFrom(null)
                      setPath(null, 'idle')
                    }}
                    aria-label="清除路径起点与结果"
                  >
                    清除路径
                  </button>
                )}
              </div>
              <div className="path-status">
                起点 <b>{pathFrom != null && rt ? rt.nodes[pathFrom].tag : node.tag}</b>
                {pathFrom == null && '（默认当前条目，可用"设为起点"更改）'}
                {pathStatus === 'idle' && ' · 输入目标 tag 后回车'}
                {pathStatus === 'searching' && ' · 搜索中…'}
                {pathStatus === 'found' && path && ` · 路径长度 ${path.length} 节点`}
                {pathStatus === 'none' && ' · 无依赖路径或目标 tag 不存在'}
              </div>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
