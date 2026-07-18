// TOUR 导览：沿最长依赖链（或路径查找结果）逐节点飞行。
// 每个链节点一个关键帧：镜头位于链节点侧后方并看向下一节点；
// 段时长默认 3.2s（TOUR SEGMENT 参数）、smoothstep 缓动；到达即高亮并联动侧栏。
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { graph, nodeWorldPos } from '../data/loader'
import { frameRefs, useAtlas } from '../store'
import { cameraApi } from './CameraRig'

const _pos = new THREE.Vector3()
const _look = new THREE.Vector3()
const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _l0 = new THREE.Vector3()
const _l1 = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _side = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const _tmp = { x: 0, y: 0, z: 0 }

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

function cubicInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** 关键帧 i 的相机位（链节点侧后方） */
function keyPos(chain: number[], i: number, stretch: number, out: THREE.Vector3): void {
  const rt = graph.current
  if (!rt) return
  const n = chain.length
  nodeWorldPos(rt, chain[i], stretch, _tmp)
  _a.set(_tmp.x, _tmp.y, _tmp.z)
  nodeWorldPos(rt, chain[Math.min(i + 1, n - 1)], stretch, _tmp)
  _b.set(_tmp.x, _tmp.y, _tmp.z)
  _dir.subVectors(_b, _a)
  if (_dir.lengthSq() < 1e-6) _dir.set(0.3, -0.4, 1)
  _dir.normalize()
  _side.crossVectors(_dir, UP)
  if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0)
  _side.normalize()
  out.copy(_a).addScaledVector(_dir, -14).addScaledVector(_side, 8).addScaledVector(UP, 6)
}

/** 关键帧 i 的注视点（下一节点，末节点看自身） */
function keyLook(chain: number[], i: number, stretch: number, out: THREE.Vector3): void {
  const rt = graph.current
  if (!rt) return
  const n = chain.length
  nodeWorldPos(rt, chain[Math.min(i + 1, n - 1)], stretch, _tmp)
  out.set(_tmp.x, _tmp.y, _tmp.z)
}

export function Tour() {
  const phaseRef = useRef<'idle' | 'enter' | 'run'>('idle')
  const enterT = useRef(0)
  const segT = useRef(0)
  const lastStep = useRef(-1)
  const startPos = useRef(new THREE.Vector3())
  const startLook = useRef(new THREE.Vector3())
  const tourStatus = useAtlas((s) => s.tour.status)

  // 导览开始：取消飞行，记录起点，进入 enter 阶段
  useEffect(() => {
    if (tourStatus !== 'idle') {
      cameraApi.cancelFlight()
      const c = cameraApi.getControls()
      const s = useAtlas.getState()
      if (c) {
        startPos.current.copy(c.camera.position)
        c.getTarget(startLook.current)
      }
      phaseRef.current = 'enter'
      enterT.current = 0
      segT.current = 0
      lastStep.current = -1
      if (s.tour.chain.length > 0) s.select(s.tour.chain[0])
    } else {
      phaseRef.current = 'idle'
      lastStep.current = -1
    }
  }, [tourStatus])

  useFrame((_, delta) => {
    if (phaseRef.current === 'idle') return
    const s = useAtlas.getState()
    const rt = graph.current
    const c = cameraApi.getControls()
    if (!rt || !c) return
    const chain = s.tour.chain
    const n = chain.length
    if (n === 0) {
      phaseRef.current = 'idle'
      return
    }
    const dt = Math.min(delta, 0.1)
    const stretch = frameRefs.stretch

    if (phaseRef.current === 'enter') {
      const dur = Math.min(1.4, s.params.tourSegment)
      enterT.current += dt
      const raw = Math.min(1, enterT.current / dur)
      const k = cubicInOut(raw)
      keyPos(chain, 0, stretch, _p0)
      keyLook(chain, 0, stretch, _l0)
      _pos.lerpVectors(startPos.current, _p0, k)
      _look.lerpVectors(startLook.current, _l0, k)
      c.setLookAt(_pos.x, _pos.y, _pos.z, _look.x, _look.y, _look.z, false)
      if (raw >= 1) {
        phaseRef.current = 'run'
        segT.current = 0
        lastStep.current = 0
      }
      return
    }

    // run 阶段
    if (s.tour.step !== lastStep.current) {
      lastStep.current = s.tour.step
      segT.current = 0
      s.select(chain[s.tour.step])
    }
    if (s.tour.status === 'playing') {
      segT.current += dt / Math.max(0.1, s.params.tourSegment)
      if (segT.current >= 1) {
        if (s.tour.step < n - 1) {
          s.setTourStep(s.tour.step + 1)
        } else {
          // 到达末节点：停住等待用户退出
          segT.current = 1
          s.setTourPlaying(false)
        }
      }
    }
    const k = smoothstep(Math.min(1, segT.current))
    const step = Math.min(s.tour.step, n - 1)
    keyPos(chain, step, stretch, _p0)
    keyLook(chain, step, stretch, _l0)
    keyPos(chain, Math.min(step + 1, n - 1), stretch, _p1)
    keyLook(chain, Math.min(step + 1, n - 1), stretch, _l1)
    _pos.lerpVectors(_p0, _p1, k)
    _look.lerpVectors(_l0, _l1, k)
    c.setLookAt(_pos.x, _pos.y, _pos.z, _look.x, _look.y, _look.z, false)
  }, -2)

  return null
}
