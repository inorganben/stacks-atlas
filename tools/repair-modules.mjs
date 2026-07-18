// 修复 node_modules 完整性：本工作区 fuse 挂载上 npm 并发解包会随机丢文件。
// 改为从 npm cache 取 tarball（npm pack 走缓存）+ tar 单进程确定性解包覆盖。
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const root = process.cwd()
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
function pkgNameFromPath(p) {
  const parts = p.split('/')
  const last = parts[parts.length - 1]
  const scope = parts[parts.length - 2]
  if (scope && scope.startsWith('@')) return `${scope}/${last}`
  return last
}

const pkgs = Object.entries(lock.packages)
  .filter(([k]) => k.startsWith('node_modules/'))
  .map(([k, v]) => ({ path: k, name: pkgNameFromPath(k), version: v.version }))

const tmp = '/tmp/stacks-atlas-pkgs'
mkdirSync(tmp, { recursive: true })

let fail = 0
for (const p of pkgs) {
  const dest = join(root, p.path)
  // 打包（命中缓存，几乎零网络）
  const r = spawnSync('npm', ['pack', `${p.name}@${p.version}`, '--pack-destination', tmp, '--silent'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if (r.status !== 0) {
    console.error(`PACK FAIL ${p.name}@${p.version}: ${r.stderr?.slice(0, 200)}`)
    fail++
    continue
  }
  const tgz = join(tmp, r.stdout.trim().split('\n').pop())
  if (!existsSync(tgz)) {
    console.error(`TGZ MISSING ${p.name}: ${tgz}`)
    fail++
    continue
  }
  mkdirSync(dest, { recursive: true })
  const x = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1'], { encoding: 'utf8' })
  if (x.status !== 0) {
    console.error(`EXTRACT FAIL ${p.name}: ${x.stderr?.slice(0, 200)}`)
    fail++
  }
}
console.log(`repaired ${pkgs.length - fail}/${pkgs.length} packages`)
process.exit(fail > 0 ? 1 : 0)
