// 左下图例（可折叠）：类型配色 + 过滤器（章多选 / 类型多选 / 高度区间双滑杆）。
import { useAtlas } from '../store'
import { NODE_TYPES, TYPE_COLORS } from '../data/types'
import type { NodeType } from '../data/types'
import { graph } from '../data/loader'

export function Legend() {
  const open = useAtlas((s) => s.legendOpen)
  const toggle = useAtlas((s) => s.toggleLegend)
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const filters = useAtlas((s) => s.filters)
  const toggleType = useAtlas((s) => s.toggleTypeFilter)
  const toggleChapter = useAtlas((s) => s.toggleChapterFilter)
  const setHeight = useAtlas((s) => s.setHeightFilter)
  const clearFilters = useAtlas((s) => s.clearFilters)
  const rt = ready ? graph.current : null
  const maxHeight = rt ? rt.maxHeight : 100

  const typeActive = (t: NodeType) => filters.types.length === 0 || filters.types.includes(t)
  const hMin = Math.min(filters.hMin, filters.hMax)
  const hMax = Math.max(filters.hMin, filters.hMax)
  const filtering =
    filters.chapters.length > 0 || filters.types.length > 0 || hMin > 0 || hMax < maxHeight

  return (
    <div className={`hud-block legend${open ? '' : ' collapsed'}`}>
      <div className="legend-head" onClick={toggle} role="button" aria-label="折叠或展开图例" tabIndex={0}>
        <span>LEGEND · FILTER</span>
        <span>{open ? '−' : '+'}</span>
      </div>
      {open && (
        <div className="legend-body">
          {NODE_TYPES.map((t) => (
            <button
              key={t}
              className={`legend-item${typeActive(t) ? '' : ' off'}`}
              onClick={() => toggleType(t)}
              aria-label={`按类型 ${t} 过滤`}
              aria-pressed={typeActive(t)}
            >
              <span className="dot" style={{ background: TYPE_COLORS[t] }} />
              <span>{t}</span>
            </button>
          ))}

          <div className="legend-sec">HEIGHT RANGE</div>
          <div className="height-range">
            <div className="row">
              <span>MIN</span>
              <input
                type="range"
                min={0}
                max={maxHeight}
                step={1}
                value={hMin}
                aria-label="高度下限"
                onChange={(e) => setHeight(Number(e.target.value), hMax)}
              />
              <output>{hMin}</output>
            </div>
            <div className="row">
              <span>MAX</span>
              <input
                type="range"
                min={0}
                max={maxHeight}
                step={1}
                value={hMax > maxHeight ? maxHeight : hMax}
                aria-label="高度上限"
                onChange={(e) => setHeight(hMin, Number(e.target.value))}
              />
              <output>{hMax > maxHeight ? maxHeight : hMax}</output>
            </div>
          </div>

          {rt && rt.chapters.length > 0 && (
            <>
              <div className="legend-sec">CHAPTERS</div>
              <div className="chapter-filter">
                {rt.chapters.map((ch) => {
                  const checked = filters.chapters.length === 0 || filters.chapters.includes(ch.slug)
                  return (
                    <label key={ch.slug}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleChapter(ch.slug)}
                      />
                      <span>
                        {String(ch.id).padStart(2, '0')} {ch.title}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          )}

          {filtering && (
            <button className="btn" style={{ marginTop: 8 }} onClick={clearFilters} aria-label="清除全部过滤">
              CLEAR FILTERS
            </button>
          )}
        </div>
      )}
    </div>
  )
}
