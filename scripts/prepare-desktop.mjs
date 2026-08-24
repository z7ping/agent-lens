import { access, mkdir, readFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createReadStream, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const runtime = resolve(root, 'apps', 'desktop', 'runtime')

await access(resolve(dist, 'daemon.mjs')).catch(() => {
  throw new Error('dist/daemon.mjs is missing; run npm run build:dist first')
})
await access(resolve(dist, 'web', 'index.html')).catch(() => {
  throw new Error('dist/web/index.html is missing; run npm run build:dist first')
})

await rm(runtime, { recursive: true, force: true })
await cp(dist, runtime, { recursive: true })

const pkg = JSON.parse(await readFile(resolve(root, 'apps', 'desktop', 'package.json'), 'utf8'))
const electronDistRel = pkg.build.electronDist
if (electronDistRel) {
  await ensureElectronDist(resolve(root, 'apps', 'desktop', electronDistRel), pkg.devDependencies.electron)
}

console.log('[AgentLens] desktop runtime prepared')

async function ensureElectronDist(target, electronVersion) {
  if (existsSync(join(target, 'electron.exe'))) return
  const get = require('@electron/get')
  console.log(`[AgentLens] preparing electron ${electronVersion} dist at ${target}`)
  const zipPath = await get.downloadArtifact({
    version: electronVersion,
    platform: 'win32',
    arch: 'x64',
    artifactName: 'electron',
  })
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const unzipper = require('unzipper')
  const entries = createReadStream(zipPath).pipe(unzipper.Parse({ forceStream: true }))
  for await (const entry of entries) {
    const destPath = resolve(target, entry.path)
    if (!destPath.startsWith(target + '\\') && destPath !== target) {
      throw new Error(`path traversal blocked: ${entry.path}`)
    }
    if (entry.type === 'Directory') {
      await mkdir(destPath, { recursive: true })
      entry.autodrain()
      continue
    }
    await mkdir(dirname(destPath), { recursive: true })
    await pipeline(entry, createWriteStream(destPath))
  }
  if (!existsSync(join(target, 'electron.exe'))) {
    throw new Error(`electron.exe not found after extracting ${zipPath}`)
  }
}
