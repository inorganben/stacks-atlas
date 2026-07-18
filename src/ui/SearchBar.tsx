// 顶部居中搜索框：flexsearch（Worker 内构建索引 tag + 章标题 + 节标题）。
// 结果显示 tag、类型徽章、章、节；回车选中并飞至 TAG 机位。
import { useEffect, useRef, useState } from 'react'
import { graph } from '../data/loader'
import { TYPE_COLORS } from '../data/types'
import { useAtlas } from '../store'
import type { SearchBuildMsg, SearchDoc, SearchQueryMsg, SearchResultMsg } from '../workers/searchWorker'

/** 供全局快捷键 '/' 聚焦 */
export const searchApi = {
  focus: () => {
    /* 由组件注入 */
  },
}

export function SearchBar() {
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<number[]>([])
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const workerRef = useRef<Worker | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const reqId = useRef(0)

  useEffect(() => {
    const w = new Worker(new URL('../workers/searchWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (e: MessageEvent<SearchResultMsg>) => {
      if (e.data.type === 'results' && e.data.id === reqId.current) {
        setResults(e.data.ids)
        setOpen(e.data.ids.length > 0)
        setCursor(0)
      }
    }
    return () => {
      w.terminate()
      workerRef.current = null
    }
  }, [])

  // 数据就绪后在 Worker 内构建索引
  useEffect(() => {
    if (!ready) return
    const rt = graph.current
    const w = workerRef.current
    if (!rt || !w) return
    const docs: SearchDoc[] = new Array(rt.nodeCount)
    for (let i = 0; i < rt.nodeCount; i++) {
      const nd = rt.nodes[i]
      docs[i] = {
        id: i,
        tag: nd.tag,
        chapter: rt.chapters[rt.nodeChapter[i]]?.title ?? nd.chapter,
        section: nd.section,
      }
    }
    const msg: SearchBuildMsg = { type: 'build', docs }
    w.postMessage(msg)
  }, [ready])

  useEffect(() => {
    searchApi.focus = () => inputRef.current?.focus()
  }, [])

  const onChange = (v: string) => {
    setQuery(v)
    const w = workerRef.current
    if (!w) return
    reqId.current++
    if (v.trim().length === 0) {
      setResults([])
      setOpen(false)
      return
    }
    const msg: SearchQueryMsg = { type: 'search', id: reqId.current, query: v }
    w.postMessage(msg)
  }

  const goto = (idx: number) => {
    const s = useAtlas.getState()
    s.select(idx)
    s.flyTo('tag', { nodeIndex: idx })
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const rt = graph.current

  return (
    <div className="hud-block search">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="SEARCH TAG / CHAPTER / SECTION  ( / )"
        aria-label="搜索条目"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 160)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (results.length > 0) goto(results[Math.min(cursor, results.length - 1)])
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCursor((c) => Math.min(c + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCursor((c) => Math.max(c - 1, 0))
          } else if (e.key === 'Escape') {
            setOpen(false)
            inputRef.current?.blur()
          }
        }}
      />
      {open && rt && (
        <div className="search-results" role="listbox">
          {results.map((idx, k) => {
            const nd = rt.nodes[idx]
            const color = TYPE_COLORS[nd.type] ?? '#8f9bb0'
            return (
              <button
                key={nd.tag}
                role="option"
                aria-selected={k === cursor}
                className={`search-item${k === cursor ? ' sel' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  goto(idx)
                }}
                onMouseEnter={() => setCursor(k)}
              >
                <span className="tag">{nd.tag}</span>
                <span className="badge" style={{ color }}>
                  {nd.type}
                </span>
                <span className="meta">
                  {rt.chapters[rt.nodeChapter[idx]]?.title ?? nd.chapter} · {nd.section}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
