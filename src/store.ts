// zustand 单一 store：selection、hovered、filters、colorMode、quality、params、tourState、cameraCommand。
// 每帧数据（相机位置、标签投影、raycast）走 store 外的可变引用（frameRefs），不经 React setState。
import { create } from 'zustand'
import type { MetaJson, NodeType, QualityLevel } from './data/types'
import { COLOR_MODES, NODE_TYPES } from './data/types'
import { computeLongestChain, createMarker, graph } from './data/loader'

/* ---------------- 参数定义（规格书第十节，精确范围/步长/默认） ---------------- */

export interface ParamDef {
  key: keyof Params
  label: string
  min: number
  max: number
  step: number
  def: number
  fmt: (v: number) => string
}

export interface Params {
  nodeSize: number
  edgeOpacity: number
  labelBudget: number
  labelRange: number
  heightStretch: number
  arcLift: number
  bloomIntensity: number
  bloomThreshold: number
  vignette: number
  fogDensity: number
  particles: number
  tourSegment: number
  autoRotate: number
  colorMode: number
}

export const PARAM_DEFS: ParamDef[] = [
  { key: 'nodeSize', label: 'NODE SIZE', min: 0.4, max: 3, step: 0.05, def: 1, fmt: (v) => v.toFixed(2) },
  { key: 'edgeOpacity', label: 'EDGE OPACITY', min: 0, max: 0.8, step: 0.02, def: 0.28, fmt: (v) => v.toFixed(2) },
  { key: 'labelBudget', label: 'LABEL BUDGET', min: 0, max: 160, step: 4, def: 48, fmt: (v) => String(Math.round(v)) },
  { key: 'labelRange', label: 'LABEL RANGE', min: 60, max: 900, step: 10, def: 320, fmt: (v) => String(Math.round(v)) },
  { key: 'heightStretch', label: 'HEIGHT STRETCH', min: 0.4, max: 3, step: 0.05, def: 1, fmt: (v) => v.toFixed(2) },
  { key: 'arcLift', label: 'ARC LIFT', min: 0, max: 2, step: 0.05, def: 0.5, fmt: (v) => v.toFixed(2) },
  { key: 'bloomIntensity', label: 'BLOOM INTENSITY', min: 0, max: 1.6, step: 0.05, def: 0.55, fmt: (v) => v.toFixed(2) },
  { key: 'bloomThreshold', label: 'BLOOM THRESHOLD', min: 0, max: 1, step: 0.02, def: 0.62, fmt: (v) => v.toFixed(2) },
  { key: 'vignette', label: 'VIGNETTE', min: 0, max: 1, step: 0.02, def: 0.72, fmt: (v) => v.toFixed(2) },
  { key: 'fogDensity', label: 'FOG DENSITY', min: 0, max: 0.003, step: 0.0001, def: 0.0012, fmt: (v) => v.toFixed(4) },
  { key: 'particles', label: 'PARTICLES', min: 0, max: 1, step: 1, def: 1, fmt: (v) => (v >= 1 ? 'ON' : 'OFF') },
  { key: 'tourSegment', label: 'TOUR SEGMENT', min: 1, max: 8, step: 0.2, def: 3.2, fmt: (v) => `${v.toFixed(1)}s` },
  { key: 'autoRotate', label: 'AUTO-ROTATE', min: 0, max: 0.5, step: 0.01, def: 0, fmt: (v) => v.toFixed(2) },
  { key: 'colorMode', label: 'COLOR MODE', min: 0, max: 3, step: 1, def: 2, fmt: (v) => COLOR_MODES[Math.round(v)]?.toUpperCase() ?? 'TYPE' },
]

export function defaultParams(): Params {
  const p = {} as Params
  for (const d of PARAM_DEFS) p[d.key] = d.def
  return p
}

const STORAGE_KEY = 'stacks-atlas.params.v1'

/** localStorage 读取：仅接受 Number.isFinite 值并按范围钳制，缺失/损坏回默认；异常静默 */
export function loadStoredParams(): Params {
  const p = defaultParams()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return p
    const obj = JSON.parse(raw) as Record<string, unknown>
    for (const d of PARAM_DEFS) {
      const v = obj?.[d.key]
      if (typeof v === 'number' && Number.isFinite(v)) {
        p[d.key] = Math.min(d.max, Math.max(d.min, v))
      }
    }
  } catch {
    /* 静默回默认 */
  }
  return p
}

function persistParams(p: Params): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* 静默 */
  }
}

function clearStoredParams(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 静默 */
  }
}

const ALL_NODE_TYPES = NODE_TYPES

/* ---------------- 质量档 ---------------- */

export interface QualityPreset {
  dpr: number
  bloom: boolean
  smaa: boolean
  labelBudget: number
  fogDensity: number
  particles?: number
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  standard: { dpr: 1, bloom: false, smaa: false, labelBudget: 24, fogDensity: 0.0016, particles: 0 },
  high: { dpr: 1.5, bloom: true, smaa: false, labelBudget: 48, fogDensity: 0.0012 },
  cinematic: { dpr: 2, bloom: true, smaa: true, labelBudget: 80, fogDensity: 0.0009 },
}

export const QUALITY_ORDER: QualityLevel[] = ['standard', 'high', 'cinematic']

/* ---------------- 其他类型 ---------------- */

export interface CameraCommand {
  seq: number
  preset: 'overview' | 'height' | 'chapter' | 'tag'
  nodeIndex?: number
  chapterSlug?: string
}

export interface TourState {
  status: 'idle' | 'playing' | 'paused'
  chain: number[]
  step: number
  label: string
}

export interface Filters {
  chapters: string[]
  types: NodeType[]
  hMin: number
  hMax: number
}

/* ---------------- 帧级可变引用（不触发 React 渲染） ---------------- */

export const frameRefs = {
  /** 指针 NDC 坐标 */
  pointerX: 0,
  pointerY: 0,
  /** 指针自上次 raycast 后是否移动 */
  pointerMoved: false,
  /** 指针按下位置（用于 click vs drag 判定） */
  downX: 0,
  downY: 0,
  /** 当前 heightStretch 动画值 */
  stretch: 1,
  /** 实例颜色/矩阵脏标记 */
  colorsDirty: true,
  matricesDirty: true,
  edgeAlphaDirty: true,
  /** 当前帧可见标签数 */
  labelCount: 0,
  /** FPS（1s 窗口） */
  fps: 0,
  /** 相机到目标距离 */
  cameraDist: 0,
  /** 飞行进行中（CameraRig 写） */
  flightActive: false,
  /** 首帧已渲染 */
  firstFrame: false,
}

/* ---------------- 选中高亮状态（模块级，供 useFrame 直读） ---------------- */

export const highlight = {
  active: false,
  selected: -1,
  anc: createMarker(),
  desc: createMarker(),
  directDeps: new Set<number>(),
  directRefs: new Set<number>(),
  pathSet: new Set<number>(),
  /** 过滤可见性（null = 全部可见） */
  visible: null as Uint8Array | null,
}

/** 依据 filters 计算节点可见性位图 */
export function computeVisibility(filters: Filters): Uint8Array | null {
  const rt = graph.current
  if (!rt) return null
  const noChapter = filters.chapters.length === 0
  const noType = filters.types.length === 0
  const hMin = Math.min(filters.hMin, filters.hMax)
  const hMax = Math.max(filters.hMin, filters.hMax)
  const noHeight = hMin <= 0 && hMax >= rt.maxHeight
  if (noChapter && noType && noHeight) {
    highlight.visible = null
    return null
  }
  const vis = new Uint8Array(rt.nodeCount)
  const chapterSet = new Set(filters.chapters)
  const typeSet = new Set<string>(filters.types)
  for (let i = 0; i < rt.nodeCount; i++) {
    const nd = rt.nodes[i]
    const ok =
      (noChapter || chapterSet.has(nd.chapter)) &&
      (noType || typeSet.has(nd.type)) &&
      nd.height >= hMin &&
      nd.height <= hMax
    vis[i] = ok ? 1 : 0
  }
  highlight.visible = vis
  return vis
}

/* ---------------- Store ---------------- */

export interface AtlasState {
  loadStatus: 'loading' | 'ready' | 'error'
  loadError: string | null
  meta: MetaJson | null
  webglError: string | null
  contextLost: boolean
  firstFrame: boolean
  introHidden: boolean
  hudVisible: boolean
  paramsOpen: boolean
  helpOpen: boolean
  legendOpen: boolean
  reducedMotion: boolean

  selected: number | null
  selectedChapter: string | null
  hovered: number | null
  pathFrom: number | null
  path: number[] | null
  pathStatus: 'idle' | 'searching' | 'found' | 'none'
  filters: Filters
  /** 过滤/选中变更版本号（场景组件据此刷新缓冲） */
  filterVersion: number
  selectionVersion: number
  colorMode: number
  quality: QualityLevel
  params: Params
  tour: TourState
  cameraCommand: CameraCommand | null
  telemetry: { dist: number; labels: number; fps: number }

  setReady: (meta: MetaJson) => void
  setLoadError: (msg: string) => void
  setWebglError: (msg: string | null) => void
  setContextLost: (lost: boolean) => void
  setFirstFrame: () => void
  setIntroHidden: () => void
  select: (index: number | null) => void
  selectChapter: (slug: string | null) => void
  setHovered: (index: number | null) => void
  setPathFrom: (index: number | null) => void
  setPath: (path: number[] | null, status: AtlasState['pathStatus']) => void
  toggleChapterFilter: (slug: string) => void
  toggleTypeFilter: (t: NodeType) => void
  setHeightFilter: (hMin: number, hMax: number) => void
  clearFilters: () => void
  setColorMode: (m: number) => void
  cycleColorMode: () => void
  setQuality: (q: QualityLevel) => void
  cycleQuality: () => void
  setParam: (key: keyof Params, value: number, persist?: boolean) => void
  resetParams: () => void
  toggleParams: () => void
  toggleHelp: () => void
  toggleHud: () => void
  toggleLegend: () => void
  flyTo: (preset: CameraCommand['preset'], opts?: { nodeIndex?: number; chapterSlug?: string }) => void
  startTour: (chain: number[], label?: string) => void
  setTourPlaying: (playing: boolean) => void
  setTourStep: (step: number) => void
  exitTour: () => void
  setTelemetry: (t: { dist: number; labels: number; fps: number }) => void
}

let commandSeq = 0

function applySelectionHighlight(index: number | null): void {
  const rt = graph.current
  if (index == null || !rt) {
    highlight.active = false
    highlight.selected = -1
    highlight.directDeps.clear()
    highlight.directRefs.clear()
    frameRefs.colorsDirty = true
    frameRefs.matricesDirty = true
    return
  }
  highlight.active = true
  highlight.selected = index
  highlight.anc.compute(index, 'out')
  highlight.desc.compute(index, 'in')
  highlight.directDeps.clear()
  highlight.directRefs.clear()
  for (let k = rt.outStart[index]; k < rt.outStart[index + 1]; k++) highlight.directDeps.add(rt.outList[k])
  for (let k = rt.inStart[index]; k < rt.inStart[index + 1]; k++) highlight.directRefs.add(rt.inList[k])
  frameRefs.colorsDirty = true
  frameRefs.matricesDirty = true
}

export const useAtlas = create<AtlasState>()((set, get) => ({
  loadStatus: 'loading',
  loadError: null,
  meta: null,
  webglError: null,
  contextLost: false,
  firstFrame: false,
  introHidden: false,
  hudVisible: true,
  paramsOpen: false,
  helpOpen: false,
  legendOpen: true,
  reducedMotion:
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,

  selected: null,
  selectedChapter: null,
  hovered: null,
  pathFrom: null,
  path: null,
  pathStatus: 'idle',
  filters: { chapters: [], types: [], hMin: 0, hMax: Number.MAX_SAFE_INTEGER },
  filterVersion: 0,
  selectionVersion: 0,
  colorMode: loadStoredParams().colorMode,
  quality:
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0)
      ? 'standard'
      : 'cinematic',
  params: loadStoredParams(),
  tour: { status: 'idle', chain: [], step: 0, label: 'TOUR' },
  cameraCommand: null,
  telemetry: { dist: 0, labels: 0, fps: 0 },

  setReady: (meta) => set({ loadStatus: 'ready', meta }),
  setLoadError: (msg) => set({ loadStatus: 'error', loadError: msg }),
  setWebglError: (msg) => set({ webglError: msg }),
  setContextLost: (lost) => set({ contextLost: lost }),
  setFirstFrame: () => set({ firstFrame: true }),
  setIntroHidden: () => set({ introHidden: true }),

  select: (index) => {
    applySelectionHighlight(index)
    set((s) => {
      const rt = graph.current
      const chapter = index != null && rt ? rt.nodes[index].chapter : s.selectedChapter
      return { selected: index, selectedChapter: chapter, selectionVersion: s.selectionVersion + 1 }
    })
  },
  selectChapter: (slug) => set({ selectedChapter: slug }),
  setHovered: (index) => {
    if (get().hovered !== index) set({ hovered: index })
  },
  setPathFrom: (index) => set({ pathFrom: index }),
  setPath: (path, status) => {
    highlight.pathSet.clear()
    if (path) for (const i of path) highlight.pathSet.add(i)
    frameRefs.colorsDirty = true
    set((s) => ({ path, pathStatus: status, selectionVersion: s.selectionVersion + 1 }))
  },

  toggleChapterFilter: (slug) =>
    set((s) => {
      const rt = graph.current
      const all = rt ? rt.chapters.map((c) => c.slug) : []
      const cur = s.filters.chapters.length === 0 ? all : s.filters.chapters
      let next = cur.includes(slug) ? cur.filter((c) => c !== slug) : [...cur, slug]
      if (next.length >= all.length) next = []
      const filters = { ...s.filters, chapters: next }
      computeVisibility(filters)
      frameRefs.matricesDirty = true
      frameRefs.edgeAlphaDirty = true
      return { filters, filterVersion: s.filterVersion + 1 }
    }),
  toggleTypeFilter: (t) =>
    set((s) => {
      const all = ALL_NODE_TYPES
      const cur = s.filters.types.length === 0 ? all : s.filters.types
      let next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]
      if (next.length >= all.length) next = []
      const filters = { ...s.filters, types: next }
      computeVisibility(filters)
      frameRefs.matricesDirty = true
      frameRefs.edgeAlphaDirty = true
      return { filters, filterVersion: s.filterVersion + 1 }
    }),
  setHeightFilter: (hMin, hMax) =>
    set((s) => {
      const filters = { ...s.filters, hMin, hMax }
      computeVisibility(filters)
      frameRefs.matricesDirty = true
      frameRefs.edgeAlphaDirty = true
      return { filters, filterVersion: s.filterVersion + 1 }
    }),
  clearFilters: () =>
    set((s) => {
      const rt = graph.current
      const filters: Filters = { chapters: [], types: [], hMin: 0, hMax: rt ? rt.maxHeight : Number.MAX_SAFE_INTEGER }
      computeVisibility(filters)
      frameRefs.matricesDirty = true
      frameRefs.edgeAlphaDirty = true
      return { filters, filterVersion: s.filterVersion + 1 }
    }),

  setColorMode: (m) => {
    get().setParam('colorMode', m)
  },
  cycleColorMode: () => {
    const cur = Math.round(get().params.colorMode)
    get().setParam('colorMode', (cur + 1) % 4)
  },

  setQuality: (q) => {
    const preset = QUALITY_PRESETS[q]
    const params = { ...get().params }
    params.labelBudget = preset.labelBudget
    params.fogDensity = preset.fogDensity
    if (preset.particles !== undefined) params.particles = preset.particles
    persistParams(params)
    set({ quality: q, params })
  },
  cycleQuality: () => {
    const cur = QUALITY_ORDER.indexOf(get().quality)
    get().setQuality(QUALITY_ORDER[(cur + 1) % QUALITY_ORDER.length])
  },

  setParam: (key, value, persist = true) => {
    const def = PARAM_DEFS.find((d) => d.key === key)
    if (!def || !Number.isFinite(value)) return
    const v = Math.min(def.max, Math.max(def.min, value))
    const params = { ...get().params, [key]: v }
    if (persist) persistParams(params)
    const patch: Partial<AtlasState> = { params }
    if (key === 'colorMode') patch.colorMode = Math.round(v)
    set(patch)
  },
  resetParams: () => {
    clearStoredParams()
    const params = defaultParams()
    set({ params, colorMode: Math.round(params.colorMode) })
    frameRefs.colorsDirty = true
    frameRefs.matricesDirty = true
  },

  toggleParams: () => set((s) => ({ paramsOpen: !s.paramsOpen })),
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
  toggleHud: () => set((s) => ({ hudVisible: !s.hudVisible })),
  toggleLegend: () => set((s) => ({ legendOpen: !s.legendOpen })),

  flyTo: (preset, opts) => {
    commandSeq++
    set((s) => ({
      cameraCommand: { seq: commandSeq, preset, nodeIndex: opts?.nodeIndex, chapterSlug: opts?.chapterSlug },
      // 任何机位指令都先退出进行中的导览
      tour: s.tour.status === 'idle' ? s.tour : { status: 'idle', chain: [], step: 0, label: 'TOUR' },
    }))
  },

  startTour: (chain, label = 'TOUR') => {
    if (chain.length === 0) return
    highlight.pathSet.clear()
    for (const i of chain) highlight.pathSet.add(i)
    frameRefs.colorsDirty = true
    const reduced = get().reducedMotion
    set((s) => ({
      tour: { status: reduced ? 'paused' : 'playing', chain, step: 0, label },
      selectionVersion: s.selectionVersion + 1,
    }))
  },
  setTourPlaying: (playing) =>
    set((s) => (s.tour.status === 'idle' ? s : { tour: { ...s.tour, status: playing ? 'playing' : 'paused' } })),
  setTourStep: (step) =>
    set((s) => {
      const n = s.tour.chain.length
      if (n === 0) return s
      const k = Math.max(0, Math.min(n - 1, step))
      return { tour: { ...s.tour, step: k } }
    }),
  exitTour: () =>
    set((s) => {
      // 退出导览后恢复用户路径高亮（若有）
      highlight.pathSet.clear()
      if (s.path) for (const i of s.path) highlight.pathSet.add(i)
      frameRefs.colorsDirty = true
      return { tour: { status: 'idle', chain: [], step: 0, label: 'TOUR' }, selectionVersion: s.selectionVersion + 1 }
    }),

  setTelemetry: (t) => set({ telemetry: t }),
}))

/** 启动默认学习路径导览（目标：meta.maxHeightTag 或指定 tag 的最长依赖链） */
export function startDefaultTour(tag?: string): boolean {
  const rt = graph.current
  const meta = useAtlas.getState().meta
  if (!rt || !meta) return false
  const t = tag ?? meta.maxHeightTag
  const idx = rt.tagToIndex.get(t)
  if (idx == null) return false
  const chain = computeLongestChain(rt, idx)
  if (chain.length === 0) return false
  useAtlas.getState().startTour(chain, 'TOUR')
  return true
}
