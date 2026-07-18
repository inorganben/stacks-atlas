// 应用根：数据加载、URL 参数、全局快捷键、首屏标题层、错误恢复层、UI 组合。
import { Component, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { buildRuntime, graph, loadGraph, loadMeta } from './data/loader'
import { COLOR_MODES } from './data/types'
import type { QualityLevel } from './data/types'
import { frameRefs, startDefaultTour, useAtlas } from './store'
import { GraphScene } from './scene/GraphScene'
import { LabelsLayer } from './scene/Labels'
import { Hud } from './ui/Hud'
import { DetailPanel } from './ui/DetailPanel'
import { ParamsPanel } from './ui/ParamsPanel'
import { TourPanel } from './ui/TourPanel'
import { HelpOverlay } from './ui/HelpOverlay'
import { searchApi } from './ui/SearchBar'

interface UrlParams {
  tag?: string
  chapter?: string
  mode?: string
  q?: string
  tour?: string
}

function parseUrlParams(): UrlParams {
  try {
    const sp = new URLSearchParams(window.location.search)
    const out: UrlParams = {}
    for (const k of ['tag', 'chapter', 'mode', 'q', 'tour'] as const) {
      const v = sp.get(k)
      if (v) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** WebGL 初始化失败 / shader 编译错误边界 */
class GlErrorBoundary extends Component<
  { onError: (msg: string) => void; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }
  componentDidCatch(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    this.props.onError(msg)
  }
  render(): ReactNode {
    return this.state.hasError ? null : this.props.children
  }
}

export default function App() {
  const loadStatus = useAtlas((s) => s.loadStatus)
  const loadError = useAtlas((s) => s.loadError)
  const webglError = useAtlas((s) => s.webglError)
  const contextLost = useAtlas((s) => s.contextLost)
  const meta = useAtlas((s) => s.meta)
  const quality = useAtlas((s) => s.quality)
  const firstFrame = useAtlas((s) => s.firstFrame)
  const introHidden = useAtlas((s) => s.introHidden)
  const [glRetry, setGlRetry] = useState(0)
  const [introFading, setIntroFading] = useState(false)

  // ---- 启动：URL 参数 + 数据加载 ----
  useEffect(() => {
    const url = parseUrlParams()
    const st = useAtlas.getState()
    // q：无效值回退 HIGH
    if (url.q) {
      const q = url.q.toLowerCase()
      if (q === 'standard' || q === 'high' || q === 'cinematic') st.setQuality(q as QualityLevel)
      else st.setQuality('high')
    }
    let cancelled = false
    Promise.all([loadMeta(), loadGraph()])
      .then(([metaJson, graphJson]) => {
        if (cancelled) return
        buildRuntime(graphJson)
        const rt = graph.current
        useAtlas.getState().setReady(metaJson)
        if (!rt) return
        const s = useAtlas.getState()
        // mode：URL 优先于 storage（仅本次运行，不写回）
        if (url.mode) {
          const idx = (COLOR_MODES as readonly string[]).indexOf(url.mode.toLowerCase())
          if (idx >= 0) s.setParam('colorMode', idx, false)
        }
        // tag：选中并飞至 TAG 机位
        if (url.tag) {
          const idx = rt.tagToIndex.get(url.tag.toUpperCase())
          if (idx != null) {
            s.select(idx)
            s.flyTo('tag', { nodeIndex: idx })
          }
        }
        // chapter：选中章并飞至 CHAPTER 机位
        if (url.chapter && rt.chapterToIndex.has(url.chapter)) {
          s.selectChapter(url.chapter)
          s.flyTo('chapter', { chapterSlug: url.chapter })
        }
        // tour：进入即开始导览（1 = 默认目标）
        if (url.tour) {
          if (url.tour === '1') startDefaultTour()
          else startDefaultTour(url.tour.toUpperCase())
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        useAtlas.getState().setLoadError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- 全局快捷键（焦点在 input/textarea/select 时失效） ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return
      }
      const s = useAtlas.getState()
      switch (e.key) {
        case '1':
          s.flyTo('overview')
          break
        case '2':
          s.flyTo('height')
          break
        case '3':
          s.flyTo('chapter')
          break
        case '4':
          if (s.selected != null) s.flyTo('tag', { nodeIndex: s.selected })
          break
        case 't':
        case 'T':
          if (s.tour.status !== 'idle') s.exitTour()
          else startDefaultTour()
          break
        case 'v':
        case 'V':
          s.cycleColorMode()
          break
        case 'f':
        case 'F':
          if (s.selected != null) s.flyTo('tag', { nodeIndex: s.selected })
          break
        case '/':
          e.preventDefault()
          searchApi.focus()
          break
        case 'p':
        case 'P':
          s.toggleParams()
          break
        case 'h':
        case 'H':
          s.toggleHud()
          break
        case 'Escape':
          if (s.helpOpen) s.toggleHelp()
          else if (s.tour.status !== 'idle') s.exitTour()
          else if (s.paramsOpen) s.toggleParams()
          else {
            s.select(null)
            if (s.path) s.setPath(null, 'idle')
            if (s.pathFrom != null) s.setPathFrom(null)
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- 遥测：每 .25s 写入 store ----
  useEffect(() => {
    const id = window.setInterval(() => {
      useAtlas.getState().setTelemetry({
        dist: frameRefs.cameraDist,
        labels: frameRefs.labelCount,
        fps: frameRefs.fps,
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [])

  // ---- 首屏标题层：首个 WebGL 帧后 1.2s 淡出；8s 兜底 ----
  useEffect(() => {
    if (firstFrame) setIntroFading(true)
  }, [firstFrame])
  useEffect(() => {
    const id = window.setTimeout(() => {
      useAtlas.getState().setIntroHidden()
    }, 8000)
    return () => window.clearTimeout(id)
  }, [])

  const retryLowerQuality = () => {
    const s = useAtlas.getState()
    s.setQuality(s.quality === 'cinematic' ? 'high' : 'standard')
    s.setWebglError(null)
    setGlRetry((k) => k + 1)
  }

  return (
    <div id="app">
      <GlErrorBoundary
        key={glRetry}
        onError={(msg) => useAtlas.getState().setWebglError(msg || 'WebGL 初始化失败')}
      >
        <GraphScene />
      </GlErrorBoundary>
      <LabelsLayer />
      <Hud />
      <DetailPanel />
      <ParamsPanel />
      <TourPanel />
      <HelpOverlay />

      {loadStatus === 'loading' && <div id="boot">LOADING GRAPH DATA…</div>}

      {loadStatus === 'error' && (
        <div id="fatal" role="alert">
          <div className="card">
            <h3>数据文件缺失，请先运行数据管线</h3>
            <p>
              未能加载 <code>public/data/meta.json</code> 或 <code>public/data/graph.json</code>。
              本站全部数据由离线数据管线生成，请先执行 <code>python3 scripts/build_data.py</code> 后再访问。
            </p>
            {loadError && <div className="err">{loadError}</div>}
            <div className="row">
              <button className="btn" onClick={() => window.location.reload()}>
                重新加载
              </button>
            </div>
          </div>
        </div>
      )}

      {webglError && (
        <div id="fatal" role="alert">
          <div className="card">
            <h3>WEBGL 初始化失败</h3>
            <p>三维场景创建失败（WebGL 不可用或 shader 编译错误）。可降低质量档重试。</p>
            <div className="err">{webglError}</div>
            <div className="row">
              <button className="btn" onClick={retryLowerQuality}>
                降低质量重试（{quality === 'cinematic' ? 'HIGH' : 'STANDARD'}）
              </button>
              <button className="btn" onClick={() => window.location.reload()}>
                重新加载
              </button>
            </div>
          </div>
        </div>
      )}

      {contextLost && !webglError && (
        <div id="fatal" role="alert">
          <div className="card">
            <h3>WEBGL CONTEXT LOST</h3>
            <p>图形上下文丢失，等待浏览器恢复…（contextrestored 后自动继续）</p>
          </div>
        </div>
      )}

      {!introHidden && (
        <div
          id="intro"
          className={introFading ? 'fade' : ''}
          onTransitionEnd={(e) => {
            if (e.propertyName === 'opacity') useAtlas.getState().setIntroHidden()
          }}
        >
          <h1>STACKS ATLAS</h1>
          <div className="sub">THE STACKS PROJECT · DEPENDENCY CONSTELLATION</div>
          <div className="ver">
            {meta
              ? `${meta.commitShort} · ${meta.nodeCount.toLocaleString()} NODES · ${meta.edgeCount.toLocaleString()} EDGES`
              : 'WAITING FOR DATA…'}
          </div>
        </div>
      )}
    </div>
  )
}
