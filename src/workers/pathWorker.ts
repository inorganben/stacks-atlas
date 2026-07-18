// 路径查找 Worker：在依赖图上 BFS 求最短依赖路径（有向，from 沿「依赖于」方向到 to）。

export interface PathInitMsg {
  type: 'init'
  n: number
  outStart: Uint32Array
  outList: Uint32Array
}

export interface PathFindMsg {
  type: 'find'
  id: number
  from: number
  to: number
}

export interface PathResultMsg {
  type: 'path'
  id: number
  path: number[] | null
}

type InMsg = PathInitMsg | PathFindMsg

type WorkerScope = {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
  postMessage: (msg: PathResultMsg, transfer?: Transferable[]) => void
}
const ctx = self as unknown as WorkerScope

let n = 0
let outStart: Uint32Array = new Uint32Array(0)
let outList: Uint32Array = new Uint32Array(0)

function bfs(from: number, to: number): number[] | null {
  if (from === to) return [from]
  const prev = new Int32Array(n).fill(-1)
  const queue = new Int32Array(n)
  let qh = 0
  let qt = 0
  queue[qt++] = from
  prev[from] = from
  while (qh < qt) {
    const u = queue[qh++]
    const s = outStart[u]
    const e = outStart[u + 1]
    for (let k = s; k < e; k++) {
      const v = outList[k]
      if (prev[v] === -1) {
        prev[v] = u
        if (v === to) {
          // 回溯路径
          const path: number[] = []
          let cur = to
          while (cur !== from) {
            path.push(cur)
            cur = prev[cur]
          }
          path.push(from)
          path.reverse()
          return path
        }
        queue[qt++] = v
      }
    }
  }
  return null
}

ctx.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'init') {
    n = msg.n
    outStart = msg.outStart
    outList = msg.outList
    return
  }
  if (msg.type === 'find') {
    const path = n > 0 ? bfs(msg.from, msg.to) : null
    ctx.postMessage({ type: 'path', id: msg.id, path })
  }
}

export {}
