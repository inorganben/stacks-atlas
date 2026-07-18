// 统一构建入口：当前工作区挂载禁止执行二进制（fuse portal noexec），
// 需要把 esbuild 平台二进制复制到可执行位置后再运行 tsc / vite。
// 在常规环境下该逻辑透明跳过（原二进制可直接执行时不做任何复制）。
import { spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function executable(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore' })
    return r.status === 0
  } catch {
    return false
  }
}

function ensureEsbuild() {
  if (process.env.ESBUILD_BINARY_PATH) return
  for (const pkg of ['@esbuild/linux-x64/bin/esbuild', '@esbuild/darwin-arm64/bin/esbuild', '@esbuild/darwin-x64/bin/esbuild']) {
    let bin
    try {
      bin = require.resolve(pkg)
    } catch {
      continue
    }
    try {
      chmodSync(bin, 0o755)
    } catch {
      /* 忽略 */
    }
    if (executable(bin)) return
    const dest = `/tmp/stacks-atlas-esbuild-${process.pid % 100000}`
    try {
      if (!existsSync(dest) || !executable(dest)) {
        copyFileSync(bin, dest)
        chmodSync(dest, 0o755)
      }
      if (executable(dest)) {
        process.env.ESBUILD_BINARY_PATH = dest
        return
      }
    } catch {
      /* 忽略 */
    }
  }
}

ensureEsbuild()

const [, , cmd, ...rest] = process.argv
const steps =
  cmd === 'build'
    ? [
        ['node', ['node_modules/typescript/bin/tsc']],
        ['node', ['node_modules/vite/bin/vite.js', 'build', ...rest]],
      ]
    : cmd === 'dev'
      ? [['node', ['node_modules/vite/bin/vite.js', ...rest]]]
      : [['node', ['node_modules/vite/bin/vite.js', cmd, ...rest]]]

let failed = false
for (const [exe, args] of steps) {
  const r = spawnSync(exe, args, { stdio: 'inherit', env: process.env })
  if (r.status !== 0) {
    failed = true
    break
  }
}
process.exit(failed ? 1 : 0)
