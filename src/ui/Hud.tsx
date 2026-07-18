// HUD：左上标题块、顶部搜索框、左下遥测、右下控制 deck、左下图例。
// 整体 pointer-events:none，控件自身恢复 auto。遥测每 .25s 更新（见 App 定时器）。
import { useAtlas, startDefaultTour } from '../store'
import { COLOR_MODES } from '../data/types'
import { SearchBar } from './SearchBar'
import { Legend } from './Legend'

export function Hud() {
  const meta = useAtlas((s) => s.meta)
  const hudVisible = useAtlas((s) => s.hudVisible)
  const telemetry = useAtlas((s) => s.telemetry)
  const colorMode = useAtlas((s) => s.colorMode)
  const quality = useAtlas((s) => s.quality)
  const tourStatus = useAtlas((s) => s.tour.status)
  const paramsOpen = useAtlas((s) => s.paramsOpen)
  const selected = useAtlas((s) => s.selected)
  const flyTo = useAtlas((s) => s.flyTo)
  const cycleColorMode = useAtlas((s) => s.cycleColorMode)
  const cycleQuality = useAtlas((s) => s.cycleQuality)
  const toggleParams = useAtlas((s) => s.toggleParams)
  const toggleHelp = useAtlas((s) => s.toggleHelp)
  const exitTour = useAtlas((s) => s.exitTour)

  if (!hudVisible) return null
  const modeName = COLOR_MODES[colorMode] ?? 'type'

  return (
    <div id="hud">
      <div className="hud-block hud-title">
        <div className="t">STACKS ATLAS</div>
        <div className="v">
          {meta ? (
            <>
              {meta.commitShort} · {meta.nodeCount.toLocaleString()} NODES · {meta.edgeCount.toLocaleString()} EDGES
            </>
          ) : (
            'LOADING…'
          )}
        </div>
      </div>

      <SearchBar />

      <Legend />

      <div className="hud-block hud-telemetry" aria-live="off">
        DIST <b>{telemetry.dist.toFixed(1)}</b> · LABELS <b>{telemetry.labels}</b> · MODE{' '}
        <b>{modeName.toUpperCase()}</b> · FPS <b>{telemetry.fps}</b>
      </div>

      <div className={`hud-block deck${selected != null ? ' detail-open' : ''}`} role="toolbar" aria-label="视角与显示控制">
        <div className="deck-row">
          <button className="btn wide" onClick={() => flyTo('overview')} aria-label="机位 1 全景 OVERVIEW">
            CAM1<span className="k">1</span>
          </button>
          <button className="btn wide" onClick={() => flyTo('height')} aria-label="机位 2 层塔 HEIGHT">
            CAM2<span className="k">2</span>
          </button>
          <button className="btn wide" onClick={() => flyTo('chapter')} aria-label="机位 3 章 CHAPTER">
            CAM3<span className="k">3</span>
          </button>
          <button
            className="btn wide"
            onClick={() => selected != null && flyTo('tag', { nodeIndex: selected })}
            aria-label="机位 4 条目 TAG"
            disabled={selected == null}
            style={selected == null ? { opacity: 0.4 } : undefined}
          >
            CAM4<span className="k">4</span>
          </button>
        </div>
        <div className="deck-row">
          <button
            className={`btn wide${tourStatus !== 'idle' ? ' active' : ''}`}
            onClick={() => (tourStatus !== 'idle' ? exitTour() : startDefaultTour())}
            aria-label="学习路径导览 TOUR"
          >
            TOUR<span className="k">T</span>
          </button>
          <button className="btn wide" onClick={cycleColorMode} aria-label="切换着色模式">
            MODE·{modeName.toUpperCase()}
            <span className="k">V</span>
          </button>
        </div>
        <div className="deck-row">
          <button className="btn wide" onClick={cycleQuality} aria-label="切换质量档">
            {quality.toUpperCase()}
          </button>
          <button
            className={`btn wide${paramsOpen ? ' active' : ''}`}
            onClick={toggleParams}
            aria-label="参数面板"
          >
            PARAMS<span className="k">P</span>
          </button>
          <button className="btn wide" onClick={toggleHelp} aria-label="帮助">
            HELP
          </button>
        </div>
      </div>
    </div>
  )
}
