import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root=fileURLToPath(new URL('../../../',import.meta.url))
test('CLI and Desktop share the single bundled default Slim daemon; no legacy main bootstrap',async()=>{
  const daemon=await readFile(join(root,'apps/daemon/src/main.ts'),'utf8')
  const dist=await readFile(join(root,'scripts/build-distribution.mjs'),'utf8')
  const cli=await readFile(join(root,'apps/cli/src/index.ts'),'utf8')
  const desktop=await readFile(join(root,'apps/desktop/src/main.mjs'),'utf8')
  assert.match(daemon,/startSlimNativeDaemon/)
  assert.match(daemon,/resolveDefaultSlimDb/)
  assert.doesNotMatch(daemon,/dataRuntimeStoragePlugin|sessionSummaryProjectionPlugin|syncRegisteredSourceHistory/)
  assert.match(dist,/apps\/daemon\/src\/main\.ts/)
  assert.match(cli,/\.\/daemon\.mjs/)
  assert.match(desktop,/unpackedAsset\('runtime', 'daemon\.mjs'\)/)
  assert.match(desktop,/storageMode !== 'native-only'/)
  assert.match(cli,/health.storageMode !== 'native-only'/)
})
