import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { capturePolicyConfigurationPath } from '@agent-lens/capture-policy/configuration'
import {
  defaultAgentLensDataRoot,
  integrationAuthorizationPath,
  integrationPreferencesPath,
} from '@agent-lens/runtime-cordis'
import test from 'node:test'

test('npm and Desktop default runtime share the same AgentLens 1.0 integration state root', () => {
  const root = defaultAgentLensDataRoot()
  assert.equal(root, join(homedir(), '.agent-lens', '1.0'))
  assert.equal(
    capturePolicyConfigurationPath({}),
    join(root, 'config', 'capture-policy.json'),
  )
  assert.equal(
    integrationPreferencesPath({}),
    join(root, 'config', 'integration-preferences.json'),
  )
  assert.equal(
    integrationAuthorizationPath({}),
    join(root, 'config', 'integration-authorization.json'),
  )
})

test('explicit path overrides stay opt-in and do not create release-specific state roots', () => {
  assert.equal(
    capturePolicyConfigurationPath({ AGENT_LENS_CAPTURE_POLICY_PATH: '/tmp/capture.json' }),
    '/tmp/capture.json',
  )
  assert.equal(
    integrationPreferencesPath({ AGENT_LENS_INTEGRATION_PREFERENCES_PATH: '/tmp/preferences.json' }),
    '/tmp/preferences.json',
  )
  assert.equal(
    integrationAuthorizationPath({ AGENT_LENS_INTEGRATION_AUTH_PATH: '/tmp/authorization.json' }),
    '/tmp/authorization.json',
  )
})


test('dev bundle refresh restores physical Integration install intent without resetting enabled state', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(source, /AGENT_LENS_DEV_REINSTALL_INTEGRATIONS/)
  assert.match(source, /devReinstallIntegrationIds\.size > 0/)
  assert.match(source, /\.\.\.legacySelected,[\s\S]*?\.\.\.devReinstallSelected/)
  assert.match(source, /ensureLegacyPhysicalization\(physicalizationSelected\)/)
})
