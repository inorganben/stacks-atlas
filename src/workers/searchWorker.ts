// 搜索 Worker：flexsearch 索引 tag + 章标题 + 节标题（规格书第七节）。
// 构建与查询均在 Worker 内完成，主线程只收发消息。
import * as FlexSearch from 'flexsearch'

// flexsearch 0.7 的 ESM bundle 仅默认导出 { Index, Document, ... }，而 d.ts 仅声明命名导出；
// 直接命名导入会在 Rollup 打包期报错，故从 default 上取 Document。
const { Document } = (FlexSearch as unknown as { default: Pick<typeof FlexSearch, 'Document'> }).default

export interface SearchDoc {
  id: number
  tag: string
  chapter: string
  section: string
}

export interface SearchBuildMsg {
  type: 'build'
  docs: SearchDoc[]
}

export interface SearchQueryMsg {
  type: 'search'
  id: number
  query: string
}

export interface SearchResultMsg {
  type: 'results'
  id: number
  ids: number[]
}

type InMsg = SearchBuildMsg | SearchQueryMsg

type WorkerScope = {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
  postMessage: (msg: SearchResultMsg) => void
}
const ctx = self as unknown as WorkerScope

// flexsearch 的 Document 类型定义较宽松，这里用最小接口约束
interface DocIndex {
  add: (doc: SearchDoc) => void
  search: (query: string, options?: { limit?: number }) => { field: string; result: (string | number)[] }[]
}

let index: DocIndex | null = null
let byId: SearchDoc[] = []

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'build') {
    byId = msg.docs
    const Created = Document as unknown as new (opts: unknown) => DocIndex
    index = new Created({
      document: { id: 'id', index: ['tag', 'chapter', 'section'] },
      tokenize: 'forward',
      cache: 128,
      resolution: 9,
    })
    for (const d of byId) index.add(d)
    return
  }
  if (msg.type === 'search' && index) {
    const q = msg.query.trim()
    const out: number[] = []
    if (q.length > 0) {
      const seen = new Set<number>()
      // tag 精确匹配优先
      const upper = q.toUpperCase()
      for (const d of byId) {
        if (d.tag === upper) {
          out.push(d.id)
          seen.add(d.id)
          break
        }
      }
      const fields = index.search(q, { limit: 16 })
      for (const f of fields) {
        for (const r of f.result) {
          const id = typeof r === 'string' ? parseInt(r, 10) : r
          if (!seen.has(id)) {
            seen.add(id)
            out.push(id)
            if (out.length >= 12) break
          }
        }
        if (out.length >= 12) break
      }
    }
    ctx.postMessage({ type: 'results', id: msg.id, ids: out })
  }
}

export {}
