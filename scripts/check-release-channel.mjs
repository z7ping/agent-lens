import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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

const workflow = readFileSync('.github/workflows/npm-publish.yml', 'utf8')
if (workflow.includes('npm publish "$(ls release/*.tgz)"')) {
  throw new Error('npm publish 不得直接使用 release/*.tgz 相对路径，否则 npm 可能把它解析为 Git package spec')
}
if (!workflow.includes('tarballs=(release/*.tgz)')
  || !workflow.includes('[[ ${#tarballs[@]} -ne 1 ]]')
  || !workflow.includes('npm publish "./${tarballs[0]}"')) {
  throw new Error('npm 发布必须校验唯一 tarball，并使用 ./ 开头的明确本地文件路径')
}

console.log('npm 发行通道与本地 tarball 发布路径检查通过')
