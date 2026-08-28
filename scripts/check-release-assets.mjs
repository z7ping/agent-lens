import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'z7ping/agent-lens'

export function expectedReleaseAssets(version) {
  return [
    `z7ping-agent-lens-${version}.tgz`,
    'SHA256SUMS-npm.txt',
    'sbom.cdx.json',
    'package-lock.json',
    `AgentLens-${version}-Setup-x64.exe`,
    'SHA256SUMS-windows.txt',
    `AgentLens-${version}-macOS-arm64.dmg`,
    `AgentLens-${version}-macOS-arm64.zip`,
    'SHA256SUMS-macos-arm64.txt',
    `AgentLens-${version}-macOS-x64.dmg`,
    `AgentLens-${version}-macOS-x64.zip`,
    'SHA256SUMS-macos-x64.txt',
    `AgentLens-${version}-Linux-x64.AppImage`,
    `AgentLens-${version}-Linux-x64.deb`,
    'SHA256SUMS-linux-x64.txt',
    `AgentLens-${version}-Linux-arm64.AppImage`,
    `AgentLens-${version}-Linux-arm64.deb`,
    'SHA256SUMS-linux-arm64.txt',
  ]
}

export function validateReleaseAssets({ release, version, tag }) {
  const failures = []
  if (release.tagName !== tag) failures.push(`Release tag=${release.tagName}, expected=${tag}`)
  if (release.isDraft !== true) failures.push('只有 Draft Release 可以执行候选晋升检查')
  const expectedPrerelease = version.includes('-')
  if (release.isPrerelease !== expectedPrerelease) {
    failures.push(`prerelease=${release.isPrerelease}, expected=${expectedPrerelease}`)
  }
  if (!String(release.body ?? '').trim()) failures.push('Release Notes 不能为空')

  const actual = new Set((release.assets ?? []).map(asset => asset.name))
  const missing = expectedReleaseAssets(version).filter(name => !actual.has(name))
  if (missing.length) failures.push(`缺少候选产物：${missing.join(', ')}`)
  return failures
}

function readRelease(tag) {
  const output = execFileSync(
    'gh',
    ['release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease,body,assets'],
    { encoding: 'utf8' },
  )
  return JSON.parse(output)
}

async function main() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const tag = process.argv[2] ?? `v${packageJson.version}`
  const expectedTag = `v${packageJson.version}`
  if (tag !== expectedTag) throw new Error(`待晋升 Tag ${tag} 与 package.json ${expectedTag} 不一致`)

  const release = readRelease(tag)
  const failures = validateReleaseAssets({ release, version: packageJson.version, tag })
  if (failures.length) {
    throw new Error(`Release 候选尚未满足晋升条件：\n- ${failures.join('\n- ')}`)
  }
  console.log(`Release 候选产物齐全，可以晋升：${tag}`)
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
