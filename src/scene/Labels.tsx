// 标签系统：节点标签走独立 HTML 层 #labels（不用 WebGL 文字）。
// 池化 ≤96 个 div，每帧只改 transform/opacity/textContent；视距剔除 + importance 预算 + 距离渐隐；
// 选中/直接依赖/直接被引用/hover 豁免预算与距离；章标签常驻。
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { graph, shortLabel } from '../data/loader'
import { TYPE_COLORS } from '../data/types'
import { frameRefs, highlight, useAtlas } from '../store'

const POOL_SIZE = 96

interface PoolItem {
  root: HTMLDivElement
  dot: HTMLSpanElement
  txt: HTMLSpanElement
  assigned: number
  visible: boolean
}

interface ChapterItem {
  root: HTMLDivElement
  index: number
}

const labelDom: { pool: PoolItem[]; chapters: ChapterItem[] } = { pool: [], chapters: [] }

const _v = new THREE.Vector3()
// 候选排序缓冲（模块级复用，帧内不分配）
let candKeys = new Float64Array(0)
// 本帧展示列表（最多 POOL_SIZE 个）
const showIdx = new Int32Array(POOL_SIZE)
const showX = new Float32Array(POOL_SIZE)
const showY = new Float32Array(POOL_SIZE)
const showO = new Float32Array(POOL_SIZE)
// 豁免去重标记
let exemptMark = new Int32Array(0)
let exemptVer = 0

/** DOM 层（挂在 Canvas 外）：创建池化 div 与章标签 */
export function LabelsLayer() {
  const ref = useRef<HTMLDivElement>(null)
  const ready = useAtlas((s) => s.loadStatus === 'ready')

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const pool: PoolItem[] = []
    for (let i = 0; i < POOL_SIZE; i++) {
      const root = document.createElement('div')
      root.className = 'lbl'
      const dot = document.createElement('span')
      dot.className = 'dot'
      const txt = document.createElement('span')
      root.appendChild(dot)
      root.appendChild(txt)
      c.appendChild(root)
      pool.push({ root, dot, txt, assigned: -1, visible: false })
    }
    labelDom.pool = pool
    return () => {
      c.replaceChildren()
      labelDom.pool = []
      labelDom.chapters = []
    }
  }, [])

  // 章标签：数据就绪后一次性创建（数量 = 章数，常驻）
  useEffect(() => {
    if (!ready) return
    const c = ref.current
    const rt = graph.current
    if (!c || !rt) return
    const items: ChapterItem[] = []
    rt.chapters.forEach((ch, i) => {
      const root = document.createElement('div')
      root.className = 'chapter-lbl'
      root.textContent = `${String(ch.id).padStart(2, '0')} · ${ch.title}`
      root.style.fontSize = '15px'
      c.appendChild(root)
      items.push({ root, index: i })
    })
    labelDom.chapters = items
    return () => {
      for (const it of items) it.root.remove()
      labelDom.chapters = []
    }
  }, [ready])

  return <div id="labels" ref={ref} />
}

/** Canvas 内同步组件：每帧投影并更新 DOM（在 Nodes 之后执行） */
export function LabelsSync() {
  useFrame(({ camera, size }) => {
    const rt = graph.current
    const pool = labelDom.pool
    if (!rt || pool.length === 0) return
    const s = useAtlas.getState()
    const n = rt.nodeCount
    if (candKeys.length < n) candKeys = new Float64Array(n)
    if (exemptMark.length < n) exemptMark = new Int32Array(n)
    exemptVer++

    const range = s.params.labelRange
    const budget = Math.max(0, Math.min(Math.round(s.params.labelBudget), POOL_SIZE))
    const stretch = frameRefs.stretch
    const vis = highlight.visible
    const camX = camera.position.x
    const camY = camera.position.y
    const camZ = camera.position.z
    const w = size.width
    const h = size.height
    const bp = rt.basePos
    let showCount = 0

    // ---- 豁免：选中 / 直接依赖 / 直接被引用 / hover（无视预算与距离） ----
    const pushExempt = (i: number) => {
      if (i < 0 || i >= n || exemptMark[i] === exemptVer || showCount >= POOL_SIZE) return
      if (vis && !vis[i]) return
      exemptMark[i] = exemptVer
      const x = bp[i * 3]
      const y = bp[i * 3 + 1] * stretch
      const z = bp[i * 3 + 2]
      _v.set(x, y, z).project(camera)
      if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05) return
      showIdx[showCount] = i
      showX[showCount] = (_v.x * 0.5 + 0.5) * w
      showY[showCount] = (-_v.y * 0.5 + 0.5) * h
      showO[showCount] = 1
      showCount++
    }
    if (highlight.selected >= 0) pushExempt(highlight.selected)
    highlight.directDeps.forEach((i) => pushExempt(i))
    highlight.directRefs.forEach((i) => pushExempt(i))
    const hov = s.hovered
    if (hov != null) pushExempt(hov)

    // ---- 候选收集：视锥内 + 距离 < uLabelRange ----
    const range2 = range * range
    let count = 0
    for (let i = 0; i < n; i++) {
      if (vis && !vis[i]) continue
      if (exemptMark[i] === exemptVer) continue
      const x = bp[i * 3]
      const y = bp[i * 3 + 1] * stretch
      const z = bp[i * 3 + 2]
      const dx = x - camX
      const dy = y - camY
      const dz = z - camZ
      const d2 = dx * dx + dy * dy + dz * dz
      if (d2 >= range2) continue
      _v.set(x, y, z).project(camera)
      if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.02 || Math.abs(_v.y) > 1.02) continue
      const dist = Math.sqrt(d2)
      const imp = 0.6 * Math.log(1 + rt.nodes[i].indegree) + 0.4 * (1 / (1 + dist / range))
      // 数值安全打包：imp 量化到 1e-3 精度（整数）再与 i 组合。
      // key = qImp*1e6 + i，i < 20152 < 1e6 且 key ≪ 2^53（Float64 精确整数），
      // 排序按 (量化imp, i) 字典序完全确定；解码 key % 1e6 恒等还原 i。
      candKeys[count++] = Math.round(imp * 1e3) * 1e6 + i
    }
    if (count > 1) {
      ;(candKeys.subarray(0, count) as Float64Array).sort()
    }
    const take = Math.min(budget, count, POOL_SIZE - showCount)
    for (let k = 0; k < take; k++) {
      const key = candKeys[count - 1 - k]
      // key 为整数打包值：key % 1e6 精确还原节点下标（无需 Math.round）
      const i = key % 1e6
      // 防御：越界下标直接跳过，绝不访问 rt.nodes 之外
      if (i < 0 || i >= rt.nodes.length) continue
      try {
        const x = bp[i * 3]
        const y = bp[i * 3 + 1] * stretch
        const z = bp[i * 3 + 2]
        const dx = x - camX
        const dy = y - camY
        const dz = z - camZ
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
        _v.set(x, y, z).project(camera)
        // 距离超过 0.8×uLabelRange 渐隐（无跳闪）
        let o = 1
        if (dist > 0.8 * range) o = Math.max(0, 1 - (dist - 0.8 * range) / (0.2 * range))
        showIdx[showCount] = i
        showX[showCount] = (_v.x * 0.5 + 0.5) * w
        showY[showCount] = (-_v.y * 0.5 + 0.5) * h
        showO[showCount] = o
        showCount++
      } catch {
        // 单节点异常不中断标签循环其余部分
      }
    }

    // ---- 写入池化 DOM（只改 transform/opacity/textContent） ----
    for (let k = 0; k < pool.length; k++) {
      const slot = pool[k]
      if (k < showCount) {
        const node = showIdx[k]
        if (node < 0 || node >= rt.nodes.length) {
          // 防御：无效下标 → 隐藏槽位，不访问节点数据、不中断后续槽位
          if (slot.visible) {
            slot.visible = false
            slot.assigned = -1
            slot.root.style.opacity = '0'
          }
          continue
        }
        if (slot.assigned !== node) {
          slot.assigned = node
          // 优先显示可读短名（裁掉 chapter/type 前缀），空则回退 tag
          slot.txt.textContent = shortLabel(rt.nodes[node])
          const color = TYPE_COLORS[rt.nodes[node].type] ?? '#8f9bb0'
          slot.dot.style.background = color
          slot.dot.style.color = color
        }
        slot.root.style.transform = `translate3d(${showX[k].toFixed(1)}px,${showY[k].toFixed(1)}px,0) translate(-50%,-130%)`
        const o = showO[k].toFixed(3)
        if (slot.root.style.opacity !== o) slot.root.style.opacity = o
        slot.visible = true
      } else if (slot.visible) {
        slot.visible = false
        slot.assigned = -1
        slot.root.style.opacity = '0'
      }
    }
    frameRefs.labelCount = showCount

    // ---- 章标签：常驻，字号随距离 10–15px（用 scale 实现避免重排），opacity 下限 .25 ----
    const R = rt.radius
    for (const item of labelDom.chapters) {
      const ch = rt.chapters[item.index]
      const x = ch.center[0]
      const y = ch.center[1] * stretch
      const z = ch.center[2]
      const dx = x - camX
      const dy = y - camY
      const dz = z - camZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      _v.set(x, y, z).project(camera)
      if (_v.z > 1 || _v.z < -1) {
        if (item.root.style.opacity !== '0') item.root.style.opacity = '0'
        continue
      }
      const sx = (_v.x * 0.5 + 0.5) * w
      const sy = (-_v.y * 0.5 + 0.5) * h
      const t = Math.min(1, Math.max(0, (dist - R * 1.2) / (R * 1.2)))
      const o = 1 - 0.75 * t
      const fontT = Math.min(1, dist / (R * 2.4))
      const scale = (15 - fontT * 5) / 15
      item.root.style.transform = `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) translate(-50%,-50%) scale(${scale.toFixed(3)})`
      const os = o.toFixed(3)
      if (item.root.style.opacity !== os) item.root.style.opacity = os
    }
  }, 0)
  return null
}
