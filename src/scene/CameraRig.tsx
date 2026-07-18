// 相机装置：drei CameraControls + 4 机位预设（2.2s cubic ease-in-out 飞行）。
// 交互接管：canvas 的 pointerdown/wheel 在 capture 阶段先退出 TOUR 与飞行，手势照常生效；
// CameraControls 的 controlstart 事件做兜底。
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { CameraControls } from '@react-three/drei'
import type CameraControlsImpl from 'camera-controls'
import { graph } from '../data/loader'
import { frameRefs, useAtlas } from '../store'

const _pos = new THREE.Vector3()
const _tgt = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _node = { x: 0, y: 0, z: 0 }

/** 自动旋转角速度：autoRotate=1 时 60 s/圈（camera-controls 2.x 无内建 autoRotate，需手动推进方位角） */
const AUTO_ROTATE_RAD_PER_SEC = Math.PI / 30

/** cubic ease-in-out */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

interface Flight {
  active: boolean
  t: number
  dur: number
  fromPos: THREE.Vector3
  fromTgt: THREE.Vector3
  toPos: THREE.Vector3
  toTgt: THREE.Vector3
}

/** 模块级相机 API：供 Tour / 外部调用 */
export const cameraApi = {
  cancelFlight: () => {
    /* 由 CameraRig 注入 */
  },
  getControls: (): CameraControlsImpl | null => null,
}

export function CameraRig() {
  const controlsRef = useRef<CameraControlsImpl>(null)
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const cameraCommand = useAtlas((s) => s.cameraCommand)
  const ready = useAtlas((s) => s.loadStatus === 'ready')

  const flightRef = useRef<Flight>({
    active: false,
    t: 0,
    dur: 2.2,
    fromPos: new THREE.Vector3(),
    fromTgt: new THREE.Vector3(),
    toPos: new THREE.Vector3(),
    toTgt: new THREE.Vector3(),
  })

  // 注入模块级 API
  useEffect(() => {
    cameraApi.cancelFlight = () => {
      flightRef.current.active = false
      frameRefs.flightActive = false
    }
    cameraApi.getControls = () => controlsRef.current
  }, [])

  // 数据就绪后瞬移到 OVERVIEW 初始机位
  useEffect(() => {
    if (!ready) return
    const rt = graph.current
    const c = controlsRef.current
    if (!rt || !c) return
    const R = rt.radius
    c.setLookAt(0, R * 0.9, R * 1.55, 0, 0, 0, false)
  }, [ready])

  // 机位预设计算 → 启动飞行
  useEffect(() => {
    if (!cameraCommand || !ready) return
    const rt = graph.current
    const c = controlsRef.current
    if (!rt || !c) return
    const R = rt.radius
    const stretch = frameRefs.stretch
    const { preset } = cameraCommand
    let ok = true

    if (preset === 'overview') {
      _pos.set(0, R * 0.9, R * 1.55)
      _tgt.set(0, 0, 0)
    } else if (preset === 'height') {
      _pos.set(R * 1.9, R * 0.25, 0)
      _tgt.set(0, 0, 0)
    } else if (preset === 'chapter') {
      let slug = cameraCommand.chapterSlug ?? useAtlas.getState().selectedChapter
      if (!slug || !rt.chapterToIndex.has(slug)) {
        // 未选章时回退到规模最大章
        let best = 0
        for (let i = 1; i < rt.chapters.length; i++) if (rt.chapters[i].nodeCount > rt.chapters[best].nodeCount) best = i
        slug = rt.chapters[best]?.slug
      }
      const ch = rt.chapters[rt.chapterToIndex.get(slug ?? '') ?? -1]
      if (!ch) {
        ok = false
      } else {
        useAtlas.getState().selectChapter(ch.slug)
        _pos.set(ch.center[0], ch.center[1] * stretch + ch.radius * 1.1, ch.center[2] + ch.radius * 1.7)
        _tgt.set(ch.center[0], ch.center[1] * stretch, ch.center[2])
      }
    } else {
      // tag 机位：目标节点 pos 沿其入边平均方向后退 26、抬高 10
      const idx = cameraCommand.nodeIndex ?? useAtlas.getState().selected
      if (idx == null || idx < 0 || idx >= rt.nodeCount) {
        ok = false
      } else {
        _node.x = rt.basePos[idx * 3]
        _node.y = rt.basePos[idx * 3 + 1] * stretch
        _node.z = rt.basePos[idx * 3 + 2]
        _dir.set(0, 0, 0)
        const s = rt.inStart[idx]
        const e = rt.inStart[idx + 1]
        const cnt = e - s
        if (cnt > 0) {
          for (let k = s; k < e; k++) {
            const j = rt.inList[k]
            _dir.x += rt.basePos[j * 3] - _node.x
            _dir.y += rt.basePos[j * 3 + 1] * stretch - _node.y
            _dir.z += rt.basePos[j * 3 + 2] - _node.z
          }
          _dir.divideScalar(cnt)
        }
        if (_dir.lengthSq() < 1e-6) _dir.set(0.4, 0.35, 1)
        _dir.normalize()
        _pos.set(_node.x + _dir.x * 26, _node.y + _dir.y * 26 + 10, _node.z + _dir.z * 26)
        _tgt.set(_node.x, _node.y, _node.z)
      }
    }
    if (!ok) return

    const f = flightRef.current
    const reduced = useAtlas.getState().reducedMotion
    f.fromPos.copy(camera.position)
    c.getTarget(f.fromTgt)
    f.toPos.copy(_pos)
    f.toTgt.copy(_tgt)
    f.t = 0
    f.dur = reduced ? 0.3 : 2.2
    f.active = true
    frameRefs.flightActive = true
  }, [cameraCommand, ready, camera])

  // 交互接管：capture 阶段先退出 TOUR 与飞行（手势不拦截，照常生效）
  useEffect(() => {
    const el = gl.domElement
    const takeOver = () => {
      const s = useAtlas.getState()
      if (s.tour.status !== 'idle') s.exitTour()
      if (flightRef.current.active) {
        flightRef.current.active = false
        frameRefs.flightActive = false
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      frameRefs.downX = e.clientX
      frameRefs.downY = e.clientY
      takeOver()
    }
    const onWheel = () => takeOver()
    const onPointerMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        frameRefs.pointerX = ((e.clientX - r.left) / r.width) * 2 - 1
        frameRefs.pointerY = -(((e.clientY - r.top) / r.height) * 2 - 1)
        frameRefs.pointerMoved = true
      }
    }
    el.addEventListener('pointerdown', onPointerDown, true)
    el.addEventListener('wheel', onWheel, true)
    el.addEventListener('pointermove', onPointerMove, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onPointerDown, true)
      el.removeEventListener('wheel', onWheel, true)
      el.removeEventListener('pointermove', onPointerMove)
    }
  }, [gl])

  // CameraControls controlstart 兜底接管
  useEffect(() => {
    const c = controlsRef.current
    if (!c) return
    const onStart = () => {
      const s = useAtlas.getState()
      if (s.tour.status !== 'idle') s.exitTour()
      if (flightRef.current.active) {
        flightRef.current.active = false
        frameRefs.flightActive = false
      }
    }
    c.addEventListener('controlstart', onStart)
    return () => c.removeEventListener('controlstart', onStart)
  }, [ready])

  // useFrame 顺序：导览/飞行推进（priority -2 在 Tour 同级，先挂载先执行）→ controls.update（drei -1）→ 实例/标签（0）
  useFrame((_, delta) => {
    const c = controlsRef.current
    if (!c) return
    const dt = Math.min(delta, 0.1)
    const f = flightRef.current
    if (f.active) {
      f.t += dt
      const raw = Math.min(1, f.t / f.dur)
      const k = easeInOutCubic(raw)
      _pos.lerpVectors(f.fromPos, f.toPos, k)
      _tgt.lerpVectors(f.fromTgt, f.toTgt, k)
      c.setLookAt(_pos.x, _pos.y, _pos.z, _tgt.x, _tgt.y, _tgt.z, false)
      if (raw >= 1) {
        f.active = false
        frameRefs.flightActive = false
      }
    }
    // 自动旋转（飞行/导览时暂停；按 dt 手动推进方位角，不触碰 azimuthRotateSpeed 以免影响拖拽手感）
    const s = useAtlas.getState()
    const auto = s.params.autoRotate
    if (auto > 0 && !f.active && s.tour.status === 'idle') {
      c.azimuthAngle += auto * AUTO_ROTATE_RAD_PER_SEC * dt
    }
    // 遥测：相机到目标距离
    c.getTarget(_tgt)
    frameRefs.cameraDist = camera.position.distanceTo(_tgt)
  }, -2)

  return (
    <CameraControls
      ref={controlsRef}
      makeDefault
      smoothTime={0.08}
      draggingSmoothTime={0.08}
      minDistance={4}
      maxDistance={6000}
    />
  )
}
