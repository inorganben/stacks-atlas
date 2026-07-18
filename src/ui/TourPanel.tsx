// 导览面板：播放/暂停/上一步/下一步/退出 + 「第 k/N 步」进度。
import { graph } from '../data/loader'
import { useAtlas } from '../store'

export function TourPanel() {
  const tour = useAtlas((s) => s.tour)
  const setTourPlaying = useAtlas((s) => s.setTourPlaying)
  const setTourStep = useAtlas((s) => s.setTourStep)
  const exitTour = useAtlas((s) => s.exitTour)

  if (tour.status === 'idle') return null
  const n = tour.chain.length
  const rt = graph.current
  const curTag = rt && tour.chain[tour.step] != null ? rt.nodes[tour.chain[tour.step]].tag : ''

  return (
    <div id="tour-panel" role="toolbar" aria-label="导览控制">
      <span className="prog">
        {tour.label} · 第 <b>{Math.min(tour.step + 1, n)}</b> / {n} 步 · {curTag}
      </span>
      <button
        className="btn"
        onClick={() => setTourStep(tour.step - 1)}
        disabled={tour.step <= 0}
        aria-label="上一步"
      >
        ◂ PREV
      </button>
      {tour.status === 'playing' ? (
        <button className="btn active" onClick={() => setTourPlaying(false)} aria-label="暂停导览">
          ❚❚ PAUSE
        </button>
      ) : (
        <button className="btn" onClick={() => setTourPlaying(true)} aria-label="播放导览">
          ▸ PLAY
        </button>
      )}
      <button
        className="btn"
        onClick={() => setTourStep(tour.step + 1)}
        disabled={tour.step >= n - 1}
        aria-label="下一步"
      >
        NEXT ▸
      </button>
      <button className="btn" onClick={exitTour} aria-label="退出导览">
        EXIT
      </button>
    </div>
  )
}
