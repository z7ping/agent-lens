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
const liveTask = read('../features/LiveTaskPage.tsx')
const onboarding = read('../features/IntegrationOnboarding.tsx')
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
  const codex = read('../../public/agent-logos/codex.svg')
  assert.match(codex, /linearGradient/)
  assert.match(codex, /fill="#fff"/)
  assert.doesNotMatch(codex, /fill="currentColor"/)
  assert.match(component, /codex: \{ asset: 'codex.svg', monochrome: false \}/)
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
  assert.match(liveTask, /<AgentLogo sourceId=\{product\?\.productId \?\? current\.liveId\}/)
  assert.match(onboarding, /<AgentLogo sourceId=\{item\.integrationId\}/)
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

test('management navigator keeps primary/supported groups visible and upgrades in selected detail', () => {
  assert.match(integrationManagement, /className="integration-management-navigator"/)
  assert.match(integrationManagement, /className="integration-management-list-group"/)
  assert.match(integrationManagement, /primaryItems\.map\(item => <IntegrationManagementListItem/)
  assert.match(integrationManagement, /supportedItems\.map\(item => <IntegrationManagementListItem/)
  assert.match(integrationManagement, /className="integration-management-detail-pane"/)
  assert.doesNotMatch(integrationManagement, /supportedExpanded|integration-management-supported-disclosure/)
  assert.doesNotMatch(integrationCss, /integration-management-supported-disclosure/)
  assert.match(integrationManagement, /selectedMethod\.installCommand/)
  assert.match(integrationManagement, /selectedMethod\.updateCommand/)
  assert.match(integrationManagement, /checkAgentLatestVersion/)
  assert.match(integrationManagement, /integrationPackageUpdateAvailable/)
})
