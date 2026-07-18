// 数据加载层：fetch /data/* JSON，构建运行时图结构。
// 所有数据来自离线数据管线（scripts/build_data.py），运行时绝不请求 Stacks 官网。
import * as THREE from 'three'
import type { ChapterContent, GraphJson, MetaJson, NodeType } from './types'
import { TYPE_COLORS } from './types'

export class DataLoadError extends Error {
  readonly userMessage = '数据文件缺失，请先运行数据管线'
  constructor(
    readonly url: string,
    cause?: unknown,
  ) {
    super(`加载 ${url} 失败: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new DataLoadError(url, e)
  }
  if (!res.ok) throw new DataLoadError(url, new Error(`HTTP ${res.status}`))
  try {
    return (await res.json()) as T
  } catch (e) {
    throw new DataLoadError(url, e)
  }
}

export function loadMeta(): Promise<MetaJson> {
  return fetchJson<MetaJson>('data/meta.json')
}

/**
 * 可读短名：full_label = <chapter>-<type>-<short-name>，
 * chapter slug 自身可含连字符（如 more-algebra），用节点字段精确剥离前缀。
 */
export function shortLabel(nd: { tag: string; label?: string; chapter: string; type: string }): string {
  let s = nd.label || ''
  if (s.startsWith(nd.chapter + '-')) s = s.slice(nd.chapter.length + 1)
  if (s.startsWith(nd.type + '-')) s = s.slice(nd.type.length + 1)
  return s || nd.tag
}

export function loadGraph(): Promise<GraphJson> {
  return fetchJson<GraphJson>('data/graph.json')
}

const contentCache = new Map<string, Promise<ChapterContent>>()

/** 章内容按需加载并缓存 */
export function loadChapterContent(slug: string): Promise<ChapterContent> {
  let p = contentCache.get(slug)
  if (!p) {
    p = fetchJson<ChapterContent>(`data/content/${encodeURIComponent(slug)}.json`)
    contentCache.set(slug, p)
    p.catch(() => contentCache.delete(slug))
  }
  return p
}

/** 运行时图结构（模块级单例，避免大数组进 React 状态） */
export interface GraphRuntime {
  nodes: GraphJson['nodes']
  edges: GraphJson['edges']
  chapters: GraphJson['chapters']
  nodeCount: number
  edgeCount: number
  tagToIndex: Map<string, number>
  chapterToIndex: Map<string, number>
  /** 节点 → 章下标 */
  nodeChapter: Int32Array
  /** CSR 邻接：出边（依赖方向 from→to，即「依赖于」） */
  outStart: Uint32Array
  outList: Uint32Array
  /** CSR 邻接：入边（被引用方向） */
  inStart: Uint32Array
  inList: Uint32Array
  /** 基础布局坐标（未乘 heightStretch） */
  basePos: Float32Array
  /** 全局包围球半径 R */
  radius: number
  maxHeight: number
  maxIndegree: number
  /** 各着色模式预算好的 RGB（4 × n × 3） */
  modeColors: Float32Array[]
}

export const graph: { current: GraphRuntime | null } = { current: null }

function hexToRgb(hex: string, out: Float32Array, o: number): void {
  const c = parseInt(hex.slice(1), 16)
  out[o] = ((c >> 16) & 255) / 255
  out[o + 1] = ((c >> 8) & 255) / 255
  out[o + 2] = (c & 255) / 255
}

function lerpHex(a: string, b: string, t: number, out: Float32Array, o: number): void {
  const ca = parseInt(a.slice(1), 16)
  const cb = parseInt(b.slice(1), 16)
  for (let i = 0; i < 3; i++) {
    const va = (ca >> (16 - i * 8)) & 255
    const vb = (cb >> (16 - i * 8)) & 255
    out[o + i] = (va + (vb - va) * t) / 255
  }
}

const _hsl = { h: 0, s: 0, l: 0 }
const _col = new THREE.Color()

/** 章着色的 20 色确定性色环 */
function chapterRingColor(idx: number, out: Float32Array, o: number): void {
  _hsl.h = ((idx % 20) * 18) / 360
  _hsl.s = 0.62
  _hsl.l = 0.6
  _col.setHSL(_hsl.h, _hsl.s, _hsl.l)
  out[o] = _col.r
  out[o + 1] = _col.g
  out[o + 2] = _col.b
}

/** 由 graph.json 构建全部派生结构 */
export function buildRuntime(g: GraphJson): GraphRuntime {
  const n = g.nodes.length
  const m = g.edges.length
  const tagToIndex = new Map<string, number>()
  const chapterToIndex = new Map<string, number>()
  g.chapters.forEach((c, i) => chapterToIndex.set(c.slug, i))
  const nodeChapter = new Int32Array(n)
  const basePos = new Float32Array(n * 3)
  let maxHeight = 0
  let maxIndegree = 0
  for (let i = 0; i < n; i++) {
    const nd = g.nodes[i]
    tagToIndex.set(nd.tag, i)
    nodeChapter[i] = chapterToIndex.get(nd.chapter) ?? 0
    basePos[i * 3] = nd.pos[0]
    basePos[i * 3 + 1] = nd.pos[1]
    basePos[i * 3 + 2] = nd.pos[2]
    if (nd.height > maxHeight) maxHeight = nd.height
    if (nd.indegree > maxIndegree) maxIndegree = nd.indegree
  }

  // CSR 邻接表（出边 = 依赖，入边 = 被引用）
  const outStart = new Uint32Array(n + 1)
  const inStart = new Uint32Array(n + 1)
  for (let e = 0; e < m; e++) {
    outStart[g.edges[e][0] + 1]++
    inStart[g.edges[e][1] + 1]++
  }
  for (let i = 0; i < n; i++) {
    outStart[i + 1] += outStart[i]
    inStart[i + 1] += inStart[i]
  }
  const outList = new Uint32Array(m)
  const inList = new Uint32Array(m)
  const outCursor = outStart.slice(0, n)
  const inCursor = inStart.slice(0, n)
  for (let e = 0; e < m; e++) {
    const a = g.edges[e][0]
    const b = g.edges[e][1]
    outList[outCursor[a]++] = b
    inList[inCursor[b]++] = a
  }

  // 包围球半径：章中心 + 章半径的最大值
  let radius = 1
  for (const c of g.chapters) {
    const d = Math.hypot(c.center[0], c.center[1], c.center[2]) + c.radius
    if (d > radius) radius = d
  }
  radius *= 1.05

  // 预计算四种着色模式颜色
  const modeColors: Float32Array[] = []
  for (let mode = 0; mode < 4; mode++) {
    const arr = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const nd = g.nodes[i]
      const o = i * 3
      if (mode === 0) {
        lerpHex('#2b6f9e', '#f2b84b', maxHeight > 0 ? nd.height / maxHeight : 0, arr, o)
      } else if (mode === 1) {
        chapterRingColor(nodeChapter[i], arr, o)
      } else if (mode === 2) {
        hexToRgb(TYPE_COLORS[nd.type as NodeType] ?? '#8f9bb0', arr, o)
      } else {
        const t = maxIndegree > 0 ? Math.log(1 + nd.indegree) / Math.log(1 + maxIndegree) : 0
        lerpHex('#233a55', '#ff6b4a', t, arr, o)
      }
    }
    modeColors.push(arr)
  }

  const rt: GraphRuntime = {
    nodes: g.nodes,
    edges: g.edges,
    chapters: g.chapters,
    nodeCount: n,
    edgeCount: m,
    tagToIndex,
    chapterToIndex,
    nodeChapter,
    outStart,
    outList,
    inStart,
    inList,
    basePos,
    radius,
    maxHeight,
    maxIndegree,
    modeColors,
  }
  graph.current = rt
  return rt
}

// ---------- 依赖分析（选择集计算，标记数组复用避免分配） ----------

export interface Marker {
  /** 计算从 start 出发的传递闭包（含自身） */
  compute: (start: number, direction: 'out' | 'in') => void
  test: (i: number) => boolean
  clear: () => void
}

/** 可复用的闭包标记器：内部标记数组按需增长，重复 compute 不清零重写 */
export function createMarker(): Marker {
  let marks = new Int32Array(0)
  let stack = new Int32Array(0)
  let ver = 0
  return {
    compute(start: number, direction: 'out' | 'in') {
      const rt = graph.current
      if (!rt) return
      if (marks.length < rt.nodeCount) {
        marks = new Int32Array(rt.nodeCount)
        stack = new Int32Array(rt.nodeCount)
        ver = 0
      }
      ver++
      const starts = direction === 'out' ? rt.outStart : rt.inStart
      const lists = direction === 'out' ? rt.outList : rt.inList
      let sp = 0
      stack[sp++] = start
      marks[start] = ver
      while (sp > 0) {
        const u = stack[--sp]
        const s = starts[u]
        const e = starts[u + 1]
        for (let k = s; k < e; k++) {
          const v = lists[k]
          if (marks[v] !== ver) {
            marks[v] = ver
            stack[sp++] = v
          }
        }
      }
    },
    test(i: number) {
      return i >= 0 && i < marks.length && marks[i] === ver
    },
    clear() {
      ver++
    },
  }
}

/** 节点世界坐标（应用 heightStretch 到布局 Y） */
export function nodeWorldPos(
  rt: GraphRuntime,
  i: number,
  stretch: number,
  out: { x: number; y: number; z: number },
): void {
  out.x = rt.basePos[i * 3]
  out.y = rt.basePos[i * 3 + 1] * stretch
  out.z = rt.basePos[i * 3 + 2]
}

/**
 * 最长依赖链：从 start 出发，每步走向 height 最大的直接依赖，
 * 直至 height=0 的根。用于 TOUR 镜头路径。
 */
export function computeLongestChain(rt: GraphRuntime, start: number): number[] {
  const chain: number[] = [start]
  let cur = start
  const guard = rt.nodeCount + 1
  for (let it = 0; it < guard; it++) {
    const h = rt.nodes[cur].height
    if (h <= 0) break
    const s = rt.outStart[cur]
    const e = rt.outStart[cur + 1]
    let best = -1
    let bestH = -1
    let bestIn = -1
    for (let k = s; k < e; k++) {
      const v = rt.outList[k]
      const hv = rt.nodes[v].height
      const inv = rt.nodes[v].indegree
      if (hv > bestH || (hv === bestH && inv > bestIn)) {
        bestH = hv
        bestIn = inv
        best = v
      }
    }
    if (best < 0 || bestH >= h) break
    chain.push(best)
    cur = best
    if (rt.nodes[cur].height <= 0) break
  }
  return chain
}
