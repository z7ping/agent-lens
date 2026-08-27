import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const version = process.argv[2] ?? packageJson.version
const prerelease = version.includes('-') ? version.split('-')[1]?.split('.')[0]?.toLowerCase() : ''
const tag = prerelease ? { alpha: 'alpha', beta: 'beta', rc: 'rc' }[prerelease] : 'latest'

if (!tag) {
  console.error(`Unsupported prerelease channel: ${prerelease || version}`)
  process.exitCode = 1
} else {
  process.stdout.write(tag)
}
