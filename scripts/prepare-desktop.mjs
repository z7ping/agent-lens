import { access, cp, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
console.log('[AgentLens] desktop runtime prepared')
