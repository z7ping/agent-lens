import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agentsPage = readFileSync(new URL('../AgentsPage.tsx', import.meta.url), 'utf8')
const observation = readFileSync(new URL('./IntegrationObservation.tsx', import.meta.url), 'utf8')
const legacyControl = readFileSync(new URL('./LegacySourceCaptureControl.tsx', import.meta.url), 'utf8')
const integrationPage = readFileSync(new URL('../IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const agentsCss = readFileSync(new URL('../../agents.css', import.meta.url), 'utf8')
const agentResponsiveCss = readFileSync(new URL('../../agent-insights-responsive.css', import.meta.url), 'utf8')
const integrationCss = readFileSync(new URL('../../integrations.css', import.meta.url), 'utf8')

test('managed integrations are observation-only on the Agents surface', () => {
  assert.match(agentsPage, /IntegrationObservationPanel/)
  assert.match(agentsPage, /IntegrationOnlyObservationCard/)
  assert.match(agentsPage, /agentObservationState\(agent, discovery, discoveryScanning, t, discoveryError\)/)
  assert.doesNotMatch(agentsPage, /model\.installIntegration/)
  assert.doesNotMatch(agentsPage, /model\.removeIntegration/)
  assert.doesNotMatch(agentsPage, /model\.authorizeIntegration/)
  assert.doesNotMatch(agentsPage, /model\.setIntegrationEnabled/)
})

test('legacy source toggle is isolated to non-managed sources until DSH migration', () => {
  assert.match(agentsPage, /management\s*\?\s*<IntegrationObservationPanel/)
  assert.match(agentsPage, /:\s*<LegacySourceCaptureControl/)
  assert.match(legacyControl, /export function LegacySourceCaptureControl/)
  assert.doesNotMatch(observation, /IntegrationAdvancedActions|IntegrationOnlyCard/)
})

test('Agents routes lifecycle work to the single integration management surface', () => {
  assert.match(agentsPage, /navigate\(\x60\/integrations\?agent=\$\{encodeURIComponent\(id\)\}\x60\)/)
  assert.match(integrationPage, /useSearchParams/)
  assert.match(integrationPage, /searchParams\.get\('agent'\)/)
  assert.match(integrationPage, /data-target=\{highlighted \? 'true' : undefined\}/)
})

test('integration observation uses flat status summary instead of a second management card', () => {
  assert.match(agentsCss, /\.integration-observation\s*\{[\s\S]*?border-top:\s*1px solid var\(--al-line\);[\s\S]*?background:\s*var\(--al-soft-2\);/)
  assert.match(agentsCss, /\.integration-placeholder-body\s*\{/)
  assert.match(integrationCss, /\.integration-management-row\[data-target='true'\]/)
  assert.doesNotMatch(agentsCss, /\.integration-observation\s*\{[^}]*box-shadow\s*:/s)
  assert.doesNotMatch(agentsCss, /@media\s*\(max-width:\s*767\.98px\)[\s\S]*?integration-observation/)
  assert.match(agentResponsiveCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.integration-observation/)
})

test('observation component exposes status, local discovery, availability and capabilities without lifecycle mutation', () => {
  assert.match(observation, /integrationManagementLifecycleState\(management, t\)/)
  assert.match(observation, /integrationToolPresenceLabel/)
  assert.match(observation, /management\.availability/)
  assert.match(observation, /management\.capabilities\.map/)
  assert.doesNotMatch(observation, /installIntegration|removeIntegration|authorizeIntegration|setIntegrationEnabled/)
  assert.doesNotMatch(legacyControl, /installIntegration|removeIntegration|authorizeIntegration|setIntegrationEnabled/)
})
