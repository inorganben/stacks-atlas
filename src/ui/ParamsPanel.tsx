// 参数面板：fixed top88/right40/width284，14 项参数（label + 数值 + range 滑杆），
// input 事件即时写入场景并持久化 localStorage（key stacks-atlas.params.v1）；RESET 全部恢复默认。
import { PARAM_DEFS, useAtlas } from '../store'

export function ParamsPanel() {
  const open = useAtlas((s) => s.paramsOpen)
  const params = useAtlas((s) => s.params)
  const setParam = useAtlas((s) => s.setParam)
  const resetParams = useAtlas((s) => s.resetParams)

  if (!open) return null
  return (
    <div id="params" role="dialog" aria-label="渲染参数">
      <div className="params-head">
        <span>PARAMETERS</span>
        <button className="btn" onClick={resetParams} aria-label="重置全部参数为默认值">
          RESET
        </button>
      </div>
      <div className="params-body">
        {PARAM_DEFS.map((d) => (
          <div className="param-row" key={d.key}>
            <label htmlFor={`param-${d.key}`}>{d.label}</label>
            <output>{d.fmt(params[d.key])}</output>
            <input
              id={`param-${d.key}`}
              type="range"
              min={d.min}
              max={d.max}
              step={d.step}
              value={params[d.key]}
              aria-label={d.label}
              onChange={(e) => setParam(d.key, Number(e.target.value))}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
