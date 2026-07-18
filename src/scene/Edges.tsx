// 边渲染：全量边为单个 THREE.LineSegments + 顶点色（章内直线、跨章二次贝塞尔 16 段）。
// 高亮边（祖先链/后代链/路径/导览链）走独立小容量 LineSegments 缓冲，随选中重建。
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { graph } from '../data/loader'
import type { GraphRuntime } from '../data/loader'
import { frameRefs, highlight, useAtlas } from '../store'

const ARC_SEGMENTS = 16

/** 二次贝塞尔采样：控制点 = 两端中点沿 Y 抬高 高度差×0.35 + 8×uArcLift */
function arcPoint(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  lift: number, t: number, out: { x: number; y: number; z: number },
): void {
  const my = (ay + by) / 2 + Math.abs(ay - by) * 0.35 + 8 * lift
  const u = 1 - t
  out.x = u * u * ax + 2 * u * t * ((ax + bx) / 2) + t * t * bx
  out.y = u * u * ay + 2 * u * t * my + t * t * by
  out.z = u * u * az + 2 * u * t * ((az + bz) / 2) + t * t * bz
}

const _p0 = { x: 0, y: 0, z: 0 }
const _p1 = { x: 0, y: 0, z: 0 }
const DEF_COL = [0, 0, 0, 1]

interface EdgeBuffers {
  geometry: THREE.BufferGeometry
  positions: Float32Array
  colors: Float32Array
  /** 跨章弧元数据：起始顶点、端点下标（用于 uArcLift 变化时原地重算） */
  arcVertStart: Uint32Array
  arcA: Uint32Array
  arcB: Uint32Array
  arcCount: number
  /** 每条边的起始顶点与顶点数（用于过滤透明度） */
  edgeVertStart: Uint32Array
  edgeVertCount: Uint32Array
}

function nodeColorRGB(rt: GraphRuntime, i: number, out: Float32Array, o: number): void {
  const tc = rt.modeColors[2]
  out[o] = tc[i * 3] * 0.55
  out[o + 1] = tc[i * 3 + 1] * 0.55
  out[o + 2] = tc[i * 3 + 2] * 0.55
  out[o + 3] = 1
}

/** 追加一条边（直线或 16 段弧）到缓冲，返回使用顶点数 */
function appendEdge(
  rt: GraphRuntime, a: number, b: number, lift: number,
  positions: Float32Array, colors: Float32Array, v: number,
  colA?: ArrayLike<number>, colB?: ArrayLike<number>,
): number {
  const cross = rt.nodeChapter[a] !== rt.nodeChapter[b]
  const ax = rt.basePos[a * 3]
  const ay = rt.basePos[a * 3 + 1]
  const az = rt.basePos[a * 3 + 2]
  const bx = rt.basePos[b * 3]
  const by = rt.basePos[b * 3 + 1]
  const bz = rt.basePos[b * 3 + 2]
  const ca = colA ?? DEF_COL
  const cb = colB ?? DEF_COL
  const colTmp = [0, 0, 0, 1]
  if (!cross) {
    positions[v * 3] = ax; positions[v * 3 + 1] = ay; positions[v * 3 + 2] = az
    positions[v * 3 + 3] = bx; positions[v * 3 + 4] = by; positions[v * 3 + 5] = bz
    for (let k = 0; k < 2; k++) {
      const c = k === 0 ? ca : cb
      colors[(v + k) * 4] = c[0]; colors[(v + k) * 4 + 1] = c[1]; colors[(v + k) * 4 + 2] = c[2]; colors[(v + k) * 4 + 3] = c[3]
    }
    return 2
  }
  // 弧：17 采样点 → 16 线段
  for (let k = 0; k < ARC_SEGMENTS; k++) {
    arcPoint(ax, ay, az, bx, by, bz, lift, k / ARC_SEGMENTS, _p0)
    arcPoint(ax, ay, az, bx, by, bz, lift, (k + 1) / ARC_SEGMENTS, _p1)
    const v0 = v + k * 2
    positions[v0 * 3] = _p0.x; positions[v0 * 3 + 1] = _p0.y; positions[v0 * 3 + 2] = _p0.z
    positions[v0 * 3 + 3] = _p1.x; positions[v0 * 3 + 4] = _p1.y; positions[v0 * 3 + 5] = _p1.z
    for (let e = 0; e < 2; e++) {
      const t = (k + e) / ARC_SEGMENTS
      colTmp[0] = ca[0] + (cb[0] - ca[0]) * t
      colTmp[1] = ca[1] + (cb[1] - ca[1]) * t
      colTmp[2] = ca[2] + (cb[2] - ca[2]) * t
      colTmp[3] = ca[3] + (cb[3] - ca[3]) * t
      colors[(v0 + e) * 4] = colTmp[0]
      colors[(v0 + e) * 4 + 1] = colTmp[1]
      colors[(v0 + e) * 4 + 2] = colTmp[2]
      colors[(v0 + e) * 4 + 3] = colTmp[3]
    }
  }
  return ARC_SEGMENTS * 2
}

function buildEdgeBuffers(rt: GraphRuntime, lift: number): EdgeBuffers {
  const m = rt.edgeCount
  let vcount = 0
  let arcCount = 0
  for (let e = 0; e < m; e++) {
    const cross = rt.nodeChapter[rt.edges[e][0]] !== rt.nodeChapter[rt.edges[e][1]]
    vcount += cross ? ARC_SEGMENTS * 2 : 2
    if (cross) arcCount++
  }
  const positions = new Float32Array(vcount * 3)
  const colors = new Float32Array(vcount * 4)
  const arcVertStart = new Uint32Array(arcCount)
  const arcA = new Uint32Array(arcCount)
  const arcB = new Uint32Array(arcCount)
  const edgeVertStart = new Uint32Array(m)
  const edgeVertCount = new Uint32Array(m)
  const colA = new Float32Array(4)
  const colB = new Float32Array(4)
  let v = 0
  let ai = 0
  for (let e = 0; e < m; e++) {
    const a = rt.edges[e][0]
    const b = rt.edges[e][1]
    nodeColorRGB(rt, a, colA, 0)
    nodeColorRGB(rt, b, colB, 0)
    edgeVertStart[e] = v
    const cross = rt.nodeChapter[a] !== rt.nodeChapter[b]
    if (cross) {
      arcVertStart[ai] = v
      arcA[ai] = a
      arcB[ai] = b
      ai++
    }
    v += appendEdge(rt, a, b, lift, positions, colors, v, colA, colB)
    edgeVertCount[e] = v - edgeVertStart[e]
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), rt.radius * 4 + 100)
  return { geometry, positions, colors, arcVertStart, arcA, arcB, arcCount, edgeVertStart, edgeVertCount }
}

/** uArcLift 变化时原地重算弧顶点 */
function recomputeArcs(buf: EdgeBuffers, rt: GraphRuntime, lift: number): void {
  for (let ai = 0; ai < buf.arcCount; ai++) {
    const a = buf.arcA[ai]
    const b = buf.arcB[ai]
    const ax = rt.basePos[a * 3]
    const ay = rt.basePos[a * 3 + 1]
    const az = rt.basePos[a * 3 + 2]
    const bx = rt.basePos[b * 3]
    const by = rt.basePos[b * 3 + 1]
    const bz = rt.basePos[b * 3 + 2]
    const v = buf.arcVertStart[ai]
    for (let k = 0; k < ARC_SEGMENTS; k++) {
      arcPoint(ax, ay, az, bx, by, bz, lift, k / ARC_SEGMENTS, _p0)
      arcPoint(ax, ay, az, bx, by, bz, lift, (k + 1) / ARC_SEGMENTS, _p1)
      const v0 = v + k * 2
      buf.positions[v0 * 3] = _p0.x; buf.positions[v0 * 3 + 1] = _p0.y; buf.positions[v0 * 3 + 2] = _p0.z
      buf.positions[v0 * 3 + 3] = _p1.x; buf.positions[v0 * 3 + 4] = _p1.y; buf.positions[v0 * 3 + 5] = _p1.z
    }
  }
  const attr = buf.geometry.getAttribute('position') as THREE.BufferAttribute
  attr.needsUpdate = true
}

// ---------------- 高亮缓冲 ----------------

const HL_MAX_EDGES = 22000

function buildHighlightGeometry(rt: GraphRuntime, lift: number, path: number[] | null, tourChain: number[]): THREE.BufferGeometry | null {
  // 收集：祖先链（青）、后代链（琥珀）、路径/导览链（亮白）
  const ancEdges: number[] = []
  const descEdges: number[] = []
  if (highlight.active) {
    const m = rt.edgeCount
    for (let e = 0; e < m && (ancEdges.length < HL_MAX_EDGES || descEdges.length < HL_MAX_EDGES); e++) {
      const a = rt.edges[e][0]
      const b = rt.edges[e][1]
      if (highlight.anc.test(a) && highlight.anc.test(b)) {
        if (ancEdges.length < HL_MAX_EDGES) ancEdges.push(a, b)
      } else if (highlight.desc.test(a) && highlight.desc.test(b)) {
        if (descEdges.length < HL_MAX_EDGES) descEdges.push(a, b)
      }
    }
  }
  const pathEdges: number[] = []
  const chain = tourChain.length > 1 ? tourChain : (path ?? [])
  for (let i = 0; i + 1 < chain.length && pathEdges.length < HL_MAX_EDGES * 2; i++) {
    pathEdges.push(chain[i], chain[i + 1])
  }
  const total = ancEdges.length / 2 + descEdges.length / 2 + pathEdges.length / 2
  if (total === 0) return null

  // 估算顶点数
  let vcount = 0
  const countVerts = (pairs: number[]) => {
    for (let i = 0; i < pairs.length; i += 2) {
      vcount += rt.nodeChapter[pairs[i]] !== rt.nodeChapter[pairs[i + 1]] ? ARC_SEGMENTS * 2 : 2
    }
  }
  countVerts(ancEdges); countVerts(descEdges); countVerts(pathEdges)
  const positions = new Float32Array(vcount * 3)
  const colors = new Float32Array(vcount * 4)
  let v = 0
  const write = (pairs: number[], rgb: readonly number[]) => {
    for (let i = 0; i < pairs.length; i += 2) {
      v += appendEdge(rt, pairs[i], pairs[i + 1], lift, positions, colors, v, rgb, rgb)
    }
  }
  write(ancEdges, [0.44, 0.83, 1.0, 0.9])
  write(descEdges, [0.94, 0.66, 0.28, 0.9])
  write(pathEdges, [1.0, 1.0, 1.0, 1.0])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4))
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), rt.radius * 4 + 100)
  return geometry
}

// ---------------- 组件 ----------------

export function Edges() {
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const selectionVersion = useAtlas((s) => s.selectionVersion)
  const groupRef = useRef<THREE.Group>(null)
  const matRef = useRef<THREE.LineBasicMaterial>(null)
  const hlMatRef = useRef<THREE.LineBasicMaterial>(null)
  const lastLift = useRef(-1)
  const lastOpacity = useRef(-1)

  const buffers = useMemo(() => {
    if (!ready) return null
    const rt = graph.current
    if (!rt) return null
    return buildEdgeBuffers(rt, useAtlas.getState().params.arcLift)
  }, [ready])

  useEffect(() => {
    return () => buffers?.geometry.dispose()
  }, [buffers])

  // 高亮缓冲：随选中/路径/导览重建（独立小容量，不触碰全量缓冲）
  const hlGeometry = useMemo(() => {
    if (!ready || selectionVersion < 0) return null
    const rt = graph.current
    if (!rt) return null
    const s = useAtlas.getState()
    return buildHighlightGeometry(rt, s.params.arcLift, s.path, s.tour.status !== 'idle' ? s.tour.chain : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectionVersion])

  useEffect(() => {
    return () => hlGeometry?.dispose()
  }, [hlGeometry])

  useFrame(() => {
    const rt = graph.current
    if (!rt || !buffers) return
    const s = useAtlas.getState()
    // 弧高参数即时生效（原地重算，不重建缓冲）
    const lift = s.params.arcLift
    if (lift !== lastLift.current) {
      lastLift.current = lift
      recomputeArcs(buffers, rt, lift)
    }
    // 全量边透明度：选中时 ×0.35
    const target = s.params.edgeOpacity * (highlight.active ? 0.35 : 1)
    if (matRef.current && target !== lastOpacity.current) {
      lastOpacity.current = target
      matRef.current.opacity = target
    }
    // 过滤：端点不可见的边顶点透明度归零
    if (frameRefs.edgeAlphaDirty) {
      frameRefs.edgeAlphaDirty = false
      const vis = highlight.visible
      const colors = buffers.colors
      const m = rt.edgeCount
      for (let e = 0; e < m; e++) {
        const a = rt.edges[e][0]
        const b = rt.edges[e][1]
        const alpha = !vis || (vis[a] && vis[b]) ? 1 : 0
        const s0 = buffers.edgeVertStart[e]
        const cnt = buffers.edgeVertCount[e]
        for (let k = 0; k < cnt; k++) colors[(s0 + k) * 4 + 3] = alpha
      }
      ;(buffers.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    }
    // heightStretch：整组 Y 缩放（节点侧按实例矩阵应用，保持球体不扁）
    if (groupRef.current) groupRef.current.scale.y = frameRefs.stretch
    if (hlMatRef.current) hlMatRef.current.opacity = 0.95
  })

  if (!ready || !buffers) return null

  return (
    <group ref={groupRef}>
      <lineSegments geometry={buffers.geometry} frustumCulled={false}>
        <lineBasicMaterial
          ref={matRef}
          vertexColors
          transparent
          opacity={useAtlas.getState().params.edgeOpacity}
          blending={THREE.NormalBlending}
          depthWrite={false}
          fog={false}
        />
      </lineSegments>
      {hlGeometry && (
        <lineSegments geometry={hlGeometry} frustumCulled={false}>
          <lineBasicMaterial
            ref={hlMatRef}
            vertexColors
            transparent
            opacity={0.95}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            fog={false}
          />
        </lineSegments>
      )}
    </group>
  )
}
