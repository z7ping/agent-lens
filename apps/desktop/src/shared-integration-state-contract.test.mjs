import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')

test('Desktop-managed daemon inherits shared AgentLens state environment instead of creating Desktop-only integration config', () => {
  assert.match(source, /env:\s*\{[\s\S]*?\.\.\.process\.env,[\s\S]*?AGENT_LENS_RUNTIME_OWNER:\s*'desktop'/)
  assert.doesNotMatch(source, /AGENT_LENS_CAPTURE_POLICY_PATH\s*:/)
  assert.doesNotMatch(source, /AGENT_LENS_INTEGRATION_PREFERENCES_PATH\s*:/)
  assert.doesNotMatch(source, /AGENT_LENS_INTEGRATION_AUTH_PATH\s*:/)
  assert.doesNotMatch(source, /AGENT_LENS_INTEGRATIONS_DIR\s*:/)
})

test('Desktop user-facing data directory remains the shared ~/.agent-lens/1.0 root', () => {
  assert.match(source, /join\(homedir\(\), '\.agent-lens', '1\.0'\)/)
})
