import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('PinnedAgentsProvider owns browser visibility only while IntegrationOrderProvider owns global display order', () => {
  const pinned = readFileSync(new URL('./PinnedAgentsProvider.tsx', import.meta.url), 'utf8')
  const order = readFileSync(new URL('./IntegrationOrderProvider.tsx', import.meta.url), 'utf8')
  const scope = readFileSync(new URL('./AgentScope.tsx', import.meta.url), 'utf8')

  assert.match(pinned, /readAgentVisibilityPreference/)
  assert.match(pinned, /writeAgentVisibilityPreference/)
  assert.doesNotMatch(pinned, /displayOrder|readLegacyAgentOrderPreference|updateIntegrationPreferences|IntegrationManagementResponseDto/)

  assert.match(order, /readLegacyAgentOrderPreference/)
  assert.match(order, /preferences\.displayOrder/)
  assert.match(order, /updateIntegrationPreferences\(\{ displayOrder:/)

  assert.match(scope, /usePinnedAgents\(\)/)
  assert.match(scope, /useIntegrationOrder\(\)/)
})
