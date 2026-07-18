// 帮助层（z 20）：快捷键、着色模式、质量档说明。
import { useAtlas } from '../store'

const SHORTCUTS: [string, string][] = [
  ['1 – 4', '机位预设：全景 / 层塔 / 章 / 条目'],
  ['T', '学习路径导览（再按退出）'],
  ['V', '循环着色模式 height → chapter → type → degree'],
  ['F', '聚焦当前选中条目'],
  ['/', '聚焦搜索框'],
  ['P', '参数面板开关'],
  ['H', 'HUD 显示开关'],
  ['Esc', '清除选中 / 退出导览 / 关闭面板'],
]

export function HelpOverlay() {
  const open = useAtlas((s) => s.helpOpen)
  const toggle = useAtlas((s) => s.toggleHelp)
  const meta = useAtlas((s) => s.meta)

  if (!open) return null
  return (
    <div
      id="help"
      role="dialog"
      aria-label="帮助"
      onClick={(e) => {
        if (e.target === e.currentTarget) toggle()
      }}
    >
      <div className="help-card">
        <h3>STACKS ATLAS</h3>
        <div className="sub">THE STACKS PROJECT · DEPENDENCY CONSTELLATION</div>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="note">
          节点为 Stacks Project 条目（definition / lemma / proposition / theorem / remark / example /
          exercise / situation / section），有向边表示「依赖于」。Y 轴为依赖高度（最长路径）。
          <br />
          交互：拖拽旋转 · 滚轮缩放 · 点击选中条目 · 点击空白清除。搜索支持 tag、章标题、节标题。
          <br />
          数据版本：{meta ? `${meta.commit.slice(0, 12)} · ${meta.nodeCount} nodes · ${meta.edgeCount} edges · parsed ${meta.parsedAt}` : '—'}
        </div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={toggle} aria-label="关闭帮助">
            CLOSE (ESC)
          </button>
        </div>
      </div>
    </div>
  )
}
