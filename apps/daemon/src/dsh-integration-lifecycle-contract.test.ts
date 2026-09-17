import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('DSH does not bypass the official Integration package lifecycle in the daemon composition root', () => {
  assert.doesNotMatch(main, /profiledDshSourcePlugin/)
  assert.doesNotMatch(main, /@agent-lens\/source-dsh/)
  assert.doesNotMatch(main, /app\.use\([^\n]*dsh/i)
  assert.match(main, /for \(const item of integrationPackages\.catalog\(\)\)/)
  assert.match(main, /loadInstalledAgentIntegration\(entryPath, item\.integrationId\)/)
  assert.match(main, /app\.useIntegration\(integration/)
})

test('legacy physicalization remains selected by enabled source identity rather than a DSH special case', () => {
  assert.match(main, /\.filter\(item => enabledSourceIds\.has\(item\.productId\)\)/)
  assert.match(main, /ensureLegacyPhysicalization\(legacySelected\)/)
  assert.doesNotMatch(main, /legacyDsh|dshMigration|forceEnableDsh/i)
})
