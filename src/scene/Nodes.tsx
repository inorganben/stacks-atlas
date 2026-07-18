// 全图节点：仅一个 THREE.InstancedMesh（SphereGeometry(1,10,10)）。
// 选中/祖先/后代/过滤/hover 的一切表现都通过实例颜色与实例缩放完成，禁止重建几何体。
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { graph } from '../data/loader'
import { frameRefs, highlight, useAtlas } from '../store'

// 模块级临时对象池（帧内禁止分配新对象）
const _obj = new THREE.Object3D()
const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _toP = new THREE.Vector3()

const HOVER_BOOST = 1.35
const SELECT_BOOST = 1.25
const HIDDEN_SCALE = 0.0001

/** 供拾取与外部使用的 API（模块级，避免 React 状态） */
export const nodesApi = {
  mesh: null as THREE.InstancedMesh | null,
  /** 每节点当前缩放（用于射线拾取半径） */
  scales: null as Float32Array | null,
  /**
   * 世界坐标手动射线拾取：返回命中的最近可见节点下标，无命中返回 null。
   * 用球体解析测试，不分配新对象，比 traverse 三角形快几个数量级。
   */
  pick(ndcX: number, ndcY: number, camera: THREE.Camera): number | null {
    const mesh = nodesApi.mesh
    const rt = graph.current
    const scales = nodesApi.scales
    if (!mesh || !rt || !scales) return null
    _dir.set(ndcX, ndcY, 0.5).unproject(camera)
    _origin.copy(camera.position)
    _dir.sub(_origin).normalize()
    const stretch = frameRefs.stretch
    const vis = highlight.visible
    let best = -1
    let bestT = Infinity
    const bp = rt.basePos
    for (let i = 0; i < rt.nodeCount; i++) {
      if (vis && !vis[i]) continue
      const px = bp[i * 3] - _origin.x
      const py = bp[i * 3 + 1] * stretch - _origin.y
      const pz = bp[i * 3 + 2] - _origin.z
      const t = px * _dir.x + py * _dir.y + pz * _dir.z
      if (t <= 0 || t >= bestT) continue
      _toP.set(px - _dir.x * t, py - _dir.y * t, pz - _dir.z * t)
      const r = Math.max(scales[i], 0.6)
      if (_toP.lengthSq() < r * r) {
        best = i
        bestT = t
      }
    }
    return best >= 0 ? best : null
  },
}

export function Nodes() {
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const meshRef = useRef<THREE.InstancedMesh>(null)

  // 颜色过渡与缓存（模块级生命周期跟随组件）
  const stateRef = useRef({
    n: 0,
    baseFrom: null as Float32Array | null,
    baseTo: null as Float32Array | null,
    baseCur: null as Float32Array | null,
    colorT: 1,
    lastMode: -1,
    lastHover: -1,
    initialized: false,
  })

  const geometry = useMemo(() => new THREE.SphereGeometry(1, 10, 10), [])
  const material = useMemo(() => new THREE.MeshBasicMaterial({ fog: true }), [])

  useEffect(() => {
    return () => {
      geometry.dispose()
      material.dispose()
      nodesApi.mesh = null
      nodesApi.scales = null
    }
  }, [geometry, material])

  // 数据就绪后初始化实例缓冲
  useEffect(() => {
    if (!ready) return
    const rt = graph.current
    const mesh = meshRef.current
    if (!rt || !mesh) return
    const n = rt.nodeCount
    const st = stateRef.current
    st.n = n
    st.baseFrom = new Float32Array(n * 3)
    st.baseTo = new Float32Array(n * 3)
    st.baseCur = new Float32Array(n * 3)
    nodesApi.scales = new Float32Array(n).fill(1)
    nodesApi.mesh = mesh
    mesh.count = n
    mesh.frustumCulled = false
    if (!mesh.instanceColor || mesh.instanceColor.count !== n) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    }
    st.lastMode = Math.round(useAtlas.getState().params.colorMode)
    st.baseCur.set(rt.modeColors[st.lastMode])
    st.colorT = 1
    st.initialized = true
    frameRefs.colorsDirty = true
    frameRefs.matricesDirty = true
    frameRefs.stretch = useAtlas.getState().params.heightStretch
  }, [ready])

  useFrame(({ camera }, delta) => {
    const rt = graph.current
    const mesh = meshRef.current
    const st = stateRef.current
    if (!rt || !mesh || !st.initialized) return
    const s = useAtlas.getState()
    const n = st.n
    const dt = Math.min(delta, 0.1)

    // ---- heightStretch 300ms 过渡 ----
    const targetStretch = s.params.heightStretch
    if (Math.abs(frameRefs.stretch - targetStretch) > 1e-4) {
      const k = Math.min(1, dt / 0.3)
      frameRefs.stretch += (targetStretch - frameRefs.stretch) * Math.min(1, k * 4)
      if (Math.abs(frameRefs.stretch - targetStretch) <= 1e-4) frameRefs.stretch = targetStretch
      frameRefs.matricesDirty = true
    }

    // ---- 着色模式 300ms 插值过渡 ----
    const mode = Math.round(s.params.colorMode)
    if (mode !== st.lastMode && st.baseCur && st.baseFrom && st.baseTo) {
      st.baseFrom.set(st.baseCur)
      st.baseTo.set(rt.modeColors[mode])
      st.colorT = 0
      st.lastMode = mode
    }
    if (st.colorT < 1 && st.baseCur && st.baseFrom && st.baseTo) {
      st.colorT = Math.min(1, st.colorT + dt / 0.3)
      const t = st.colorT * st.colorT * (3 - 2 * st.colorT)
      for (let i = 0; i < n * 3; i++) {
        st.baseCur[i] = st.baseFrom[i] + (st.baseTo[i] - st.baseFrom[i]) * t
      }
      frameRefs.colorsDirty = true
    }

    // ---- hover：每帧最多一次拾取（指针静止时跳过） ----
    let hoverChanged = false
    if (frameRefs.pointerMoved) {
      frameRefs.pointerMoved = false
      const hit = nodesApi.pick(frameRefs.pointerX, frameRefs.pointerY, camera)
      const next = hit ?? -1
      if (next !== st.lastHover) {
        st.lastHover = next
        s.setHovered(next >= 0 ? next : null)
        hoverChanged = true
        if (document.body) document.body.style.cursor = next >= 0 ? 'pointer' : ''
      }
    }

    // ---- 实例矩阵（位置 × stretch，缩放 = 尺寸公式 × 可见性 × 高亮） ----
    if (frameRefs.matricesDirty || hoverChanged) {
      frameRefs.matricesDirty = false
      const nodeSize = s.params.nodeSize
      const stretch = frameRefs.stretch
      const vis = highlight.visible
      const sel = highlight.selected
      const scales = nodesApi.scales
      if (!scales) return
      for (let i = 0; i < n; i++) {
        const nd = rt.nodes[i]
        let sc = nodeSize * (1 + 0.55 * Math.log2(1 + nd.indegree))
        if (vis && !vis[i]) sc = HIDDEN_SCALE
        else {
          if (i === sel) sc *= SELECT_BOOST
          if (i === st.lastHover) sc *= HOVER_BOOST
        }
        scales[i] = sc
        _obj.position.set(rt.basePos[i * 3], rt.basePos[i * 3 + 1] * stretch, rt.basePos[i * 3 + 2])
        _obj.scale.setScalar(sc)
        _obj.updateMatrix()
        mesh.setMatrixAt(i, _obj.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
    }

    // ---- 实例颜色（基础色过渡 × 选中/路径/祖先高亮） ----
    if (frameRefs.colorsDirty && st.baseCur && mesh.instanceColor) {
      frameRefs.colorsDirty = false
      const out = mesh.instanceColor.array as Float32Array
      const base = st.baseCur
      const typeColors = rt.modeColors[2]
      const sel = highlight.selected
      const pathActive = highlight.pathSet.size > 0
      const hlActive = highlight.active
      for (let i = 0; i < n; i++) {
        const o = i * 3
        let r = base[o]
        let g = base[o + 1]
        let b = base[o + 2]
        if (i === sel) {
          r = Math.min(1, r * 1.45 + 0.12)
          g = Math.min(1, g * 1.45 + 0.12)
          b = Math.min(1, b * 1.45 + 0.12)
        } else if (pathActive && highlight.pathSet.has(i)) {
          // 路径 / 导览链节点：琥珀强调
          r = 0.941
          g = 0.659
          b = 0.282
        } else if (hlActive) {
          if (highlight.directDeps.has(i)) {
            r = Math.min(1, typeColors[o] * 1.15)
            g = Math.min(1, typeColors[o + 1] * 1.15)
            b = Math.min(1, typeColors[o + 2] * 1.15)
          } else if (highlight.anc.test(i)) {
            r = typeColors[o] * 0.6
            g = typeColors[o + 1] * 0.6
            b = typeColors[o + 2] * 0.6
          } else {
            r *= 0.25
            g *= 0.25
            b *= 0.25
          }
        }
        out[o] = r
        out[o + 1] = g
        out[o + 2] = b
      }
      mesh.instanceColor.needsUpdate = true
    }
  })

  if (!ready) return null
  const rt = graph.current
  if (!rt) return null

  return (
    <instancedMesh
      key={rt.nodeCount}
      ref={meshRef}
      args={[geometry, material, rt.nodeCount]}
      frustumCulled={false}
    />
  )
}
