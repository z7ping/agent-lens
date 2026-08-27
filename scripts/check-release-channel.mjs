import { execFileSync } from 'node:child_process'

const cases = [
  ['1.0.0-alpha.3', 'alpha'],
  ['1.0.0-beta.2', 'beta'],
  ['1.0.0-rc.1', 'rc'],
  ['1.0.0', 'latest'],
]

for (const [version, expected] of cases) {
  const actual = execFileSync(process.execPath, ['scripts/resolve-npm-dist-tag.mjs', version], { encoding: 'utf8' }).trim()
  if (actual !== expected) throw new Error(`${version} 应映射到 ${expected}，实际为 ${actual}`)
}

let rejected = false
try {
  execFileSync(process.execPath, ['scripts/resolve-npm-dist-tag.mjs', '1.0.0-dev.1'], { encoding: 'utf8', stdio: 'pipe' })
} catch {
  rejected = true
}
if (!rejected) throw new Error('未知预发布通道必须拒绝发布')

console.log('npm 发行通道映射检查通过')
