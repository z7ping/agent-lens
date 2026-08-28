import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const rootPackage = await readJson(file('package.json'))
const expected = rootPackage.version
const failures = []

for (const directory of ['apps', 'packages']) {
  for (const packagePath of await packagePaths(directory)) {
    const pkg = await readJson(packagePath)
    if (pkg.version !== expected) {
      failures.push(`${packagePath.pathname}: version=${pkg.version ?? '<missing>'}, expected=${expected}`)
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        if (name.startsWith('@agent-lens/') && typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) && version !== expected) {
          failures.push(`${packagePath.pathname}: ${section}.${name}=${version}, expected=${expected}`)
        }
      }
    }
  }
}

const lock = await readJson(file('package-lock.json'))
if (lock.version !== expected) failures.push(`package-lock.json: version=${lock.version}, expected=${expected}`)
if (lock.packages?.['']?.version !== expected) failures.push(`package-lock.json packages[""]: version=${lock.packages?.['']?.version ?? '<missing>'}, expected=${expected}`)
for (const [packagePath, packageData] of Object.entries(lock.packages ?? {})) {
  if (packagePath && packageData?.name?.startsWith('@agent-lens/') && packageData.version !== expected) {
    failures.push(`package-lock.json ${packagePath}: version=${packageData.version ?? '<missing>'}, expected=${expected}`)
  }
}

if (failures.length) {
  console.error(`AgentLens 版本一致性检查失败（根版本 ${expected}）：`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`AgentLens 版本一致性检查通过：${expected}`)

function file(relativePath) {
  return new URL(`../${relativePath}`, import.meta.url)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
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
