// 氛围微粒：≤1200 点缓慢漂浮（PointsMaterial size 1.5, opacity .18），参数可整体关闭。
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { graph } from '../data/loader'
import { useAtlas } from '../store'

const COUNT = 1200

export function Particles() {
  const ready = useAtlas((s) => s.loadStatus === 'ready')
  const enabled = useAtlas((s) => s.params.particles >= 1 && !s.reducedMotion)
  const pointsRef = useRef<THREE.Points>(null)

  const geometry = useMemo(() => {
    if (!ready) return null
    const rt = graph.current
    if (!rt) return null
    const R = rt.radius
    const pos = new Float32Array(COUNT * 3)
    // 确定性伪随机（固定种子，避免每次挂载闪变）
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < COUNT; i++) {
      // 壳层分布 [0.25R, 1.6R]
      const r = R * (0.25 + 1.35 * Math.pow(rand(), 0.6))
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(2 * rand() - 1)
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.cos(phi) * 0.7
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return g
  }, [ready])

  useEffect(() => {
    return () => geometry?.dispose()
  }, [geometry])

  useFrame((_, delta) => {
    const p = pointsRef.current
    if (!p) return
    const dt = Math.min(delta, 0.1)
    p.rotation.y += dt * 0.005
    p.rotation.x += dt * 0.0012
  })

  if (!ready || !geometry || !enabled) return null
  return (
    <points ref={pointsRef} geometry={geometry} frustumCulled={false}>
      <pointsMaterial size={1.5} color="#6fd3ff" transparent opacity={0.18} depthWrite={false} sizeAttenuation />
    </points>
  )
}
