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

const publishWorkflow = readFileSync('.github/workflows/npm-publish.yml', 'utf8')
if (publishWorkflow.includes('npm pack')) {
  throw new Error('正式 npm 发布阶段不得重新 npm pack；只能发布 Draft 阶段验证过的 tgz')
}
if (!publishWorkflow.includes('gh release download "$GITHUB_REF_NAME"')
  || !publishWorkflow.includes('sha256sum -c SHA256SUMS-npm.txt')
  || !publishWorkflow.includes('tarballs=(release/*.tgz)')
  || !publishWorkflow.includes('[[ ${#tarballs[@]} -ne 1 ]]')
  || !publishWorkflow.includes('npm publish "./${tarballs[0]}"')) {
  throw new Error('正式 npm 发布必须下载 Release 候选、校验 SHA256，并使用唯一 ./ 本地 tgz 发布')
}

const candidateWorkflow = readFileSync('.github/workflows/npm-release-candidate.yml', 'utf8')
if (!candidateWorkflow.includes("tags:\n      - 'v*'")
  || !candidateWorkflow.includes('check-release-candidate.mjs --wait-seconds 120')
  || !candidateWorkflow.includes('npm pack --pack-destination release')
  || !candidateWorkflow.includes('node scripts/smoke-npm-package.mjs "./${tarballs[0]}"')
  || !candidateWorkflow.includes('Attach npm candidate to Draft Release')) {
  throw new Error('npm 候选流水线必须由 Tag 触发，经过 Draft 门禁、真实成品冒烟并挂载到 Draft Release')
}

console.log('npm 候选构建与正式发布边界检查通过')
