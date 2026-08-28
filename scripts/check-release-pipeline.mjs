import { readFileSync } from 'node:fs'

const releaseScript = readFileSync('scripts/release.ps1', 'utf8')
const windowsWorkflow = readFileSync('.github/workflows/windows-installer.yml', 'utf8')
const desktopWorkflow = readFileSync('.github/workflows/desktop-macos-linux.yml', 'utf8')
const npmCandidateWorkflow = readFileSync('.github/workflows/npm-release-candidate.yml', 'utf8')
const npmPublishWorkflow = readFileSync('.github/workflows/npm-publish.yml', 'utf8')

if (releaseScript.includes('--generate-notes')) {
  throw new Error('Release Notes 不得再依赖 GitHub --generate-notes')
}
for (const required of ['[switch]$Candidate', '[switch]$Publish', "'--draft'", 'check-release-assets.mjs', "'--draft=false'"]) {
  if (!releaseScript.includes(required)) throw new Error(`release.ps1 缺少 Draft-first 关键语义：${required}`)
}

for (const [name, workflow] of [
  ['Windows', windowsWorkflow],
  ['macOS/Linux', desktopWorkflow],
]) {
  if (!workflow.includes("tags:") || !workflow.includes("'v*'")) {
    throw new Error(`${name} 候选构建必须由 v* Tag push 触发`)
  }
  if (!workflow.includes('check-release-candidate.mjs --wait-seconds 120')) {
    throw new Error(`${name} 候选构建必须等待并验证 Draft Release`)
  }
  if (workflow.includes('types: [published]')) {
    throw new Error(`${name} 桌面构建不得在 Release published 后重新构建`)
  }
  if (!workflow.includes('Draft Release')) {
    throw new Error(`${name} 候选产物必须挂到 Draft Release`)
  }
}

if (!npmCandidateWorkflow.includes('npm pack --pack-destination release')
  || !npmCandidateWorkflow.includes('smoke:npm-package')
  || !npmCandidateWorkflow.includes('Attach npm candidate to Draft Release')) {
  throw new Error('npm Candidate 必须负责构建、真实安装验证并挂载最终 tgz')
}

if (npmPublishWorkflow.includes('npm pack')) {
  throw new Error('npm Publish 阶段禁止重新 pack')
}
if (!npmPublishWorkflow.includes('gh release download "$GITHUB_REF_NAME"')
  || !npmPublishWorkflow.includes('sha256sum -c SHA256SUMS-npm.txt')
  || !npmPublishWorkflow.includes('npm publish "./${tarballs[0]}"')) {
  throw new Error('npm Publish 必须下载、校验并发布同一个候选 tgz')
}

console.log('Draft-first 发行架构静态门禁通过')
