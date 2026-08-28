import { access, readFile, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const requested = process.argv[2]
const dryRun = process.argv.includes('--dry-run') || process.env.npm_config_dry_run === 'true'

if (!requested || requested === '--dry-run' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
  console.error('用法：node scripts/bump-version.mjs <版本号> [--dry-run]')
  console.error('示例：node scripts/bump-version.mjs 1.0.0-alpha.1')
  process.exit(1)
}

const rootPackagePath = file('package.json')
const rootPackage = await readJson(rootPackagePath)
const oldVersion = rootPackage.version
if (oldVersion === requested) {
  console.log(`版本已经是 ${requested}，无需修改。`)
  process.exit(0)
}

const workspacePackagePaths = [
  ...await packagePaths('apps'),
  ...await packagePaths('packages'),
]
const packagePathsToUpdate = [rootPackagePath, ...workspacePackagePaths]
const packages = await Promise.all(packagePathsToUpdate.map(async path => ({ path, value: await readJson(path) })))
const inconsistent = packages.filter(({ value }) => value.version !== oldVersion)
if (inconsistent.length > 0) {
  throw new Error(`workspace 版本不一致，未执行升版：${inconsistent.map(item => item.path.pathname).join(', ')}`)
}

const lockPath = file('package-lock.json')
const lock = await readJson(lockPath)
if (lock.lockfileVersion !== 3 || lock.packages?.['']?.version !== oldVersion) {
  throw new Error(`package-lock.json 根版本不是 ${oldVersion}，请先修复锁文件一致性`)
}

const sourceFiles = [
  'apps/cli/src/entry.ts',
  'apps/cli/src/index.ts',
  'apps/cli/src/hook-execution.ts',
  'apps/daemon/src/sources/dsh.ts',
  'apps/hook-hermes/plugin/agent-lens-observer/plugin.yaml',
  'packages/source-claude/src/index.ts',
  'packages/source-codex/src/index.ts',
  'packages/source-hermes/src/index.ts',
  'packages/source-opencode/src/index.ts',
  'packages/source-pi/src/index.ts',
  'packages/storage-sqlite/src/plugin.ts',
  'packages/surface-http/src/plugin.ts',
  'packages/web/src/plugin.ts',
  'scripts/smoke-distribution.mjs',
]

const changelogPath = file('CHANGELOG.md')
const changelog = await readText(changelogPath)
const changelogHeading = `## ${requested}`
const date = new Date().toISOString().slice(0, 10)
const nextChangelog = changelog.includes(changelogHeading)
  ? changelog
  : `${changelogHeading}（${date}）\n\n### Added\n\n### Changed\n- 版本更新至 ${requested}，详见本次发布说明。\n\n### Fixed\n\n### Known limitations\n\n${changelog}`

const changes = new Map()
for (const { path, value } of packages) {
  value.version = requested
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(value[section] ?? {})) {
      if (name.startsWith('@agent-lens/') && version === oldVersion) value[section][name] = requested
    }
  }
  changes.set(path, `${JSON.stringify(value, null, 2)}\n`)
}

lock.version = requested
lock.packages[''].version = requested
for (const [packagePath, packageData] of Object.entries(lock.packages)) {
  if (packagePath === '' || packageData.name?.startsWith('@agent-lens/')) {
    if (packageData.version === oldVersion) packageData.version = requested
  }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(packageData[section] ?? {})) {
      if (name.startsWith('@agent-lens/') && version === oldVersion) packageData[section][name] = requested
    }
  }
}
changes.set(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

for (const relativePath of sourceFiles) {
  const path = file(relativePath)
  const text = await readText(path)
  if (text.includes(oldVersion)) changes.set(path, text.replaceAll(oldVersion, requested))
}
changes.set(changelogPath, nextChangelog)

console.log(`${dryRun ? '[dry-run] ' : ''}准备将 ${oldVersion} 升级为 ${requested}，涉及 ${changes.size} 个文件。`)
if (!dryRun) {
  for (const [path, content] of changes) await writeFile(path, content, 'utf8')
  console.log('版本同步完成。下一步完善 CHANGELOG，再进入 Draft Release 候选阶段。')
}

function file(relativePath) {
  return new URL(`../${relativePath}`, import.meta.url)
}

async function readText(path) {
  return readFile(path, 'utf8')
}

async function readJson(path) {
  return JSON.parse(await readText(path))
}

async function packagePaths(directory) {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => file(join(directory, entry.name, 'package.json')))
  return (await Promise.all(candidates.map(async path => {
    try {
      await access(path)
      return path
    } catch {
      return null
    }
  }))).filter(Boolean)
}
