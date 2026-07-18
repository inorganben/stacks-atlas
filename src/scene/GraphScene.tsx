// 三维场景根：R3F Canvas（fov 50 / near 0.1 / far 4000 / dpr 按质量档）、
// FogExp2、EffectComposer → Bloom → Vignette → SMAA（仅 CINEMATIC）、
// 页面 hidden 停渲染循环、webglcontextlost/contextrestored 处理、点击拾取。
import { useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, Bloom, Vignette, SMAA } from '@react-three/postprocessing'
import { QUALITY_PRESETS, frameRefs, useAtlas } from '../store'
import { nodesApi } from './Nodes'
import { CameraRig } from './CameraRig'
import { Tour } from './Tour'
import { Nodes } from './Nodes'
import { Edges } from './Edges'
import { LabelsSync } from './Labels'
import { Particles } from './Particles'

/** FPS 统计（1s 窗口平滑）与首帧标记 */
function FrameStats() {
  const acc = useRef({ frames: 0, t: 0, fps: 0 })
  useFrame((_, delta) => {
    if (!frameRefs.firstFrame) {
      frameRefs.firstFrame = true
      useAtlas.getState().setFirstFrame()
    }
    const a = acc.current
    a.frames++
    a.t += delta
    if (a.t >= 1) {
      const instant = a.frames / a.t
      a.fps = a.fps === 0 ? instant : a.fps * 0.5 + instant * 0.5
      frameRefs.fps = Math.round(a.fps)
      a.frames = 0
      a.t = 0
    }
  })
  return null
}

/** 点击拾取：pointerup 位移 < 6px 视为点击；命中选中，落空清除选中 */
function PickHandler() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    const el = gl.domElement
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return
      const dx = e.clientX - frameRefs.downX
      const dy = e.clientY - frameRefs.downY
      if (dx * dx + dy * dy > 36) return
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1
      const ny = -(((e.clientY - r.top) / r.height) * 2 - 1)
      const hit = nodesApi.pick(nx, ny, camera)
      const s = useAtlas.getState()
      if (hit != null) {
        s.select(hit)
      } else if (s.selected != null) {
        s.select(null)
      }
    }
    el.addEventListener('pointerup', onUp)
    return () => el.removeEventListener('pointerup', onUp)
  }, [gl, camera])
  return null
}

export function GraphScene() {
  const quality = useAtlas((s) => s.quality)
  const fogDensity = useAtlas((s) => s.params.fogDensity)
  const bloomIntensity = useAtlas((s) => s.params.bloomIntensity)
  const bloomThreshold = useAtlas((s) => s.params.bloomThreshold)
  const vignette = useAtlas((s) => s.params.vignette)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    const fn = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  }, [])

  const preset = QUALITY_PRESETS[quality]
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, preset.dpr)

  return (
    <Canvas
      frameloop={hidden ? 'never' : 'always'}
      dpr={dpr}
      gl={{ antialias: false, powerPreference: 'high-performance', alpha: true }}
      camera={{ fov: 50, near: 0.1, far: 16000, position: [0, 60, 120] }}
      onCreated={({ gl }) => {
        const el = gl.domElement
        el.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          useAtlas.getState().setContextLost(true)
        })
        el.addEventListener('webglcontextrestored', () => {
          useAtlas.getState().setContextLost(false)
        })
      }}
    >
      <fogExp2 attach="fog" args={['#05070e', fogDensity]} />
      <CameraRig />
      <Tour />
      <Nodes />
      <Edges />
      <LabelsSync />
      <Particles />
      <FrameStats />
      <PickHandler />
      <EffectComposer multisampling={0}>
        {preset.bloom ? <Bloom intensity={bloomIntensity} luminanceThreshold={bloomThreshold} mipmapBlur /> : <></>}
        <Vignette offset={0.32} darkness={vignette} />
        {preset.smaa ? <SMAA /> : <></>}
      </EffectComposer>
    </Canvas>
  )
}
