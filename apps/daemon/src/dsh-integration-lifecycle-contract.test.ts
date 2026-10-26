import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const slimMain = readFileSync(new URL('./slim-main.ts', import.meta.url), 'utf8')

test('default Daemon only launches Slim; DSH cannot re-enable the old Cordis Writer', () => {
  assert.match(main, /startSlimNativeDaemon\(/)
  assert.doesNotMatch(main, /ensureLegacyPhysicalization|historySync|sqliteStoragePlugin/)
  assert.doesNotMatch(main, /profiledDshSourcePlugin|@agent-lens\/source-dsh/)
})

test('Slim keeps a single official Integration package lifecycle without DSH special cases', () => {
  assert.match(slimMain, /new IntegrationPackageService\(/)
  assert.match(slimMain, /await service\.initialize\(\)/)
  assert.match(slimMain, /install:id=>service\.install\(id\)/)
  assert.match(slimMain, /update:id=>service\.update\(id\)/)
  assert.match(slimMain, /remove:id=>service\.remove\(id\)/)
  assert.doesNotMatch(slimMain, /ensureLegacyPhysicalization|legacyDsh|dshMigration|forceEnableDsh/i)
})
