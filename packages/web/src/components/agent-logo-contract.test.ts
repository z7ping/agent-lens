import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const component = read('./AgentLogo.tsx')
const css = read('./agent-logo.css')
const main = read('../main.tsx')
const scope = read('./AgentScope.tsx')
const filters = read('./SidebarFilterDisclosure.tsx')
const agents = read('../features/AgentsPage.tsx')
const integrationOverview = read('../features/integrations/IntegrationObservation.tsx')
const integrationManagement = read('../features/IntegrationManagementPage.tsx')
const taskCenter = read('../features/TaskCenterPage.tsx')
const integrationCss = read('../integrations.css')

test('brand logos are local, distinct and include an upstream license', () => {
  for (const id of ['pi', 'codex', 'claude-code', 'hermes', 'opencode']) {
    assert.ok(component.includes("asset: '" + id + ".svg'"))
    const svg = read('../../public/agent-logos/' + id + '.svg')
    assert.match(svg, /^<svg/)
    assert.match(svg, /viewBox=/)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image\b/i)
  }
  assert.match(read('../../public/agent-logos/LICENSE.lobe-icons.txt'), /MIT License/)
  assert.match(read('../../public/agent-logos/README.md'), /LobeHub/)
  assert.match(component, /<UiIcon name="agent"/) // Unknown/DSH: neutral fallback.
  assert.doesNotMatch(component, /fetch\(/)
})

test('all branded workspaces reuse a single AgentLogo implementation', () => {
  assert.match(main, /import '\.\/components\/agent-logo\.css'/)
  assert.match(scope, /<AgentLogo sourceId=\{agent\.sourceId\}/)
  assert.match(filters, /<AgentLogo sourceId=\{agent\.sourceId\}/)
  assert.match(agents, /<AgentLogo sourceId=\{agent\.sourceId\}/)
  assert.match(integrationOverview, /<AgentLogo sourceId=\{management\.integrationId\}/)
  assert.match(integrationManagement, /<AgentLogo sourceId=\{item\.integrationId\}/)
  assert.match(taskCenter, /<AgentLogo sourceId=\{sourceId\}/)
  assert.doesNotMatch(scope, /function AgentIcon\(/)
  assert.doesNotMatch(integrationManagement, /sourceDot\(/)
})

test('agent-logo styles own compact sizes, avoid frames and support dark theme', () => {
  assert.match(css, /\.agent-logo--compact/)
  assert.match(css, /\.agent-logo--large/)
  assert.match(css, /:root\[data-theme='dark'\] \.agent-logo--monochrome/)
  assert.doesNotMatch(css, /!important/)
  assert.doesNotMatch(css, /border:/)
  assert.doesNotMatch(read('../shell.css'), /\.agent-icon\s*\{/)
})

test('management groups stay visible and rows alone expand, preserving upgrades', () => {
  assert.match(integrationManagement, /className="integration-management-section integration-management-section-secondary"/)
  assert.match(integrationManagement, /open=\{expanded\}/)
  assert.doesNotMatch(integrationManagement, /supportedExpanded|integration-management-supported-disclosure/)
  assert.doesNotMatch(integrationCss, /integration-management-supported-disclosure/)
  assert.match(integrationManagement, /selectedMethod\.installCommand/)
  assert.match(integrationManagement, /selectedMethod\.updateCommand/)
  assert.match(integrationManagement, /checkAgentLatestVersion/)
  assert.match(integrationManagement, /integrationPackageUpdateAvailable/)
})
