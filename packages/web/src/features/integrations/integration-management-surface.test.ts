import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const agentsPage = readFileSync(new URL('../AgentsPage.tsx', import.meta.url), 'utf8')
const onboarding = readFileSync(new URL('../IntegrationOnboarding.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const zhAgents = readFileSync(new URL('../../i18n/zh-CN/agents.ts', import.meta.url), 'utf8')
const integrationCss = readFileSync(new URL('../../integrations.css', import.meta.url), 'utf8')

test('智能体接入管理保留连续分组列表，改为紧凑折叠行而非逐项卡片', () => {
  assert.match(page, /className="integration-management-surface"/)
  assert.match(page, /className="integration-management-row"/)
  assert.match(page, /className="integration-management-disclosure"/)
  assert.match(page, /className="integration-management-section integration-management-section-secondary"/)
  assert.doesNotMatch(page, /className="integration-management-table-head"/)
  assert.doesNotMatch(page, /<h1/)
  assert.match(integrationCss, /\.integration-management-summary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/)
  assert.match(integrationCss, /\.integration-management-section\s*\{[\s\S]*?border:\s*1px solid var\(--al-line\);/)
  assert.match(integrationCss, /\.integration-management-row \+ \.integration-management-row\s*\{[\s\S]*?border-top:\s*1px solid var\(--al-line\);/)
  assert.match(integrationCss, /@media \(max-width: 1199\.98px\)/)
  assert.match(integrationCss, /@media \(max-width: 991\.98px\)/)
  assert.match(integrationCss, /@media \(max-width: 767\.98px\)/)
  assert.doesNotMatch(integrationCss, /!important/)
})

test('展开明细复用 Disclosure 并沿用真实本机路径、接入包版本与原有操作', () => {
  assert.match(page, /<Disclosure/)
  assert.match(page, /open=\{expanded\}/)
  assert.match(page, /onToggle=\{event => setExpanded\(event\.currentTarget\.open\)\}/)
  assert.match(page, /if \(highlighted \|\| ordering\) setExpanded\(true\)/)
  assert.match(page, /integrationToolPresencePath\(item\.tool\)/)
  assert.match(page, /packageState\.installedVersion/)
  assert.match(page, /packageState\?\.availableVersion/)
  assert.match(page, /installation\.versionUnavailable/)
  assert.match(page, /className="integration-management-capabilities"/)
  assert.match(page, /className="integration-management-actions"/)
  assert.match(page, /const localAgentVersion = versions\.length/)
  assert.match(page, /agentUpgradeMethods\(item\.productId\)/)
  assert.match(page, /integrationPackageUpdateAvailable\(packageState\)/)
  assert.match(page, /model\.updateIntegration\(item\.integrationId\)/)
  assert.match(page, /copyText\(kind === 'install' \? selectedMethod\.installCommand : selectedMethod\.updateCommand\)/)
  assert.match(page, /onChange=\{value => \{ setUpgradeMethod\(value\); setCopiedCommand\(null\) \}\}/)
  assert.doesNotMatch(page, /child_process|execFile|spawn\(/)
})

test('两组始终可见，只有智能体自身一级 Disclosure，深链自动展开目标行', () => {
  assert.match(page, /className="integration-management-section-head"/)
  assert.match(page, /className="integration-management-list"/)
  assert.match(page, /className="integration-management-section integration-management-section-secondary"/)
  assert.match(page, /open={expanded}/)
  assert.match(page, /if \(highlighted \|\| ordering\) setExpanded\(true\)/)
  assert.match(page, /target\?\.scrollIntoView/)
  assert.doesNotMatch(page, /supportedExpanded|integration-management-supported-disclosure/)
})

test('智能体接入页面以 Integration Management 为管理清单，不读取 Source Facet', () => {
  assert.match(page, /snapshot\.integrationManagement/)
  assert.doesNotMatch(page, /snapshot\.facets/)
  assert.doesNotMatch(page, /facets\?\.agents/)
})

test('接入管理在独立业务工具栏提供搜索、状态筛选与排序，旧路由兼容', () => {
  assert.match(app, /toolbarHost=\{workspaceToolbarHost\}/)
  assert.match(app, /<WorkspaceViewTabs/)
  assert.match(page, /createPortal/)
  assert.match(page, /className="workspace-view-controls"/)
  assert.match(page, /searchQuery/)
  assert.match(page, /statusFilter/)
  assert.match(page, /setOrdering\(value => !value\)/)
  assert.doesNotMatch(sidebar, /navigate\('\/integrations'\)/)
  assert.match(app, /<Route path="\/integrations" element=\{<LegacyIntegrationRedirect\/>\}/)
})

test('接入控制面覆盖扫描、添加、启停、授权、卸载与排序', () => {
  assert.match(app, /model\.rescanIntegrationDiscovery\(\)/)
  assert.match(page, /model\.installIntegration/)
  assert.match(page, /model\.setIntegrationEnabled/)
  assert.match(page, /model\.authorizeIntegration/)
  assert.match(page, /model\.removeIntegration/)
  assert.match(page, /model\.updateIntegration/)
  assert.match(page, /useIntegrationOrder/)
})


test('不会把完全未发现的官方 Integration 作为智能体页默认项', () => {
  assert.doesNotMatch(app, /\?\? managedIntegrationItems\[0\]\?\.integrationId/)
})

test('智能体概览选择器融合 Overview 与 Integration 目录，但不放回侧栏', () => {
  assert.match(app, /const agentSelectionMap = new Map<string, AgentFacetDto>/)
  assert.match(app, /management\.tool\?\.presence === 'present'/)
  assert.match(app, /management\.tool\?\.presence === 'data-only'/)
  assert.match(app, /agents=\{agentSelectionItems\}/)
  assert.doesNotMatch(sidebar, /agentSelectionAgents/)
})

test('未启用但已发现的智能体保持可见并支持二次接入', () => {
  assert.doesNotMatch(page, /item\.tool\?\.presence === 'present' && methods\.length/)
  assert.match(page, /item\.tool\?\.presence === 'data-only'/)
  assert.match(page, /managementPage\.add/)
  assert.match(page, /status\.notAdded/)
})


test('已发现但未接入的智能体继续显示观察卡与管理入口', () => {
  assert.match(app, /agents=\{agentSelectionItems\}/)
  assert.match(agentsPage, /const managedRows = managementItems\.map/)
  assert.match(agentsPage, /<IntegrationOnlyObservationCard/)
  assert.match(agentsPage, /onManage=\{id => navigate\(\`\/agents\?view=management&agent=\$\{encodeURIComponent\(id\)\}\`\)\}/)
  assert.doesNotMatch(agentsPage, /model\.installIntegration/)
  assert.doesNotMatch(agentsPage, /model\.setIntegrationEnabled/)
})

test('当前概览和接入管理具有实际重新扫描入口', () => {
  assert.match(app, /model\.rescanAgentEnvironment\(\{/)
  assert.match(app, /model\.rescanIntegrationDiscovery\(\)/)
  assert.match(app, /<AgentRescanAction/)
  assert.match(app, /<IntegrationRescanAction/)
})

test('首次向导自动扫描但不默认选择或自动安装', () => {
  assert.match(onboarding, /useState<Set<string>>\(\(\) => new Set\(\)\)/)
  assert.match(onboarding, /const chosen = detected\.filter\(item => selected\.has\(item\.integrationId\)\)/)
  assert.match(onboarding, /disabled=\{scanning \|\| selected\.size === 0\}/)
  assert.match(onboarding, /onClick=\{\(\) => void finish\(\)\}/)
})

test('首次扫描失败不得落入“未发现”分组', () => {
  assert.match(onboarding, /item\.tool\?\.presence === 'error'/)
  assert.match(onboarding, /item\.tool\?\.presence === 'absent'/)
  assert.match(onboarding, /onboarding\.scanFailedAgents/)
  assert.match(onboarding, /onboarding\.noneConfirmed/)
  assert.doesNotMatch(onboarding, /missing = useMemo\(\(\) => items\.filter\(item => !selectable\(item\)\)/)
})

test('接入页把本机发现状态与接入启停状态分开表达', () => {
  assert.match(page, /integrationManagementLifecycleState\(item, t\)/)
  assert.match(page, /packageState\?\.installed/)
  assert.match(page, /integrationManagementLifecycleState/)
  assert.match(page, /visibleNewIds/)
  assert.match(page, /model\.updateIntegrationPreferences\(\{ acknowledgedIntegrationIds \}\)/)
})


test('未发现且未接入的官方智能体不展示无效的禁用添加按钮', () => {
  assert.match(page, /packageState\.installed \|\| canInstall/)
  assert.doesNotMatch(page, /disabled=\{!packageState\.installed && !canInstall\}/)
})

test('全局扫描失败不会把未知项塞进“其他支持/未检测到”分组', () => {
  assert.match(page, /const discoveryFailed = Boolean\(snapshot\.integrationDiscoveryError\)/)
  assert.match(page, /const supportedItems = discoveryFailed \? \[\] : filteredItems\.filter/)
})

test('扫描失败与 data-only 保持独立语义', () => {
  assert.match(page, /integrationToolPresenceLabel/)
  assert.match(page, /toolPresence\.dataOnlyHint/)
  assert.match(app, /status\.scanFailed/)
})

test('首次未发现时明确指向智能体接入管理视图', () => {
  assert.match(zhAgents, /智能体 → 接入管理/)
})

test('接入插件更新与智能体本体升级命令是两个明确独立的交互', () => {
  assert.match(page, /managementPage\.updateIntegration/)
  assert.match(page, /managementPage\.updateDialogDescription/)
  assert.match(page, /managementPage\.agentUpgradeHeading/)
  assert.match(page, /managementPage\.agentUpgradeWarning/)
  assert.match(page, /managementPage\.officialUpgradeDocs/)
  assert.match(page, /item\.tool\?\.presence === 'present'/)
  assert.match(page, /snapshot\.agents\?\.items\.find\(agent => agent\.productId === item\.productId\)\?\.installations/)
  assert.match(zhAgents, /agentUpgradeWarning: '以下是官方安装方式的参考命令/)
  assert.match(zhAgents, /updateScope: '仅更新 AgentLens 的接入插件/)
})
test('没有更新或本机工具未被发现时，安装/更新两条命令及复制操作仍常驻', () => {
  assert.match(page, /methods\.length > 0/)
  assert.match(page, /selectedMethod\.installCommand/)
  assert.match(page, /selectedMethod\.updateCommand/)
  assert.match(page, /managementPage\.installCommand/)
  assert.match(page, /managementPage\.upgradeCommand/)
  assert.match(page, /copyAgentUpgrade\('install'\)/)
  assert.match(page, /copyAgentUpgrade\('update'\)/)
  assert.match(page, /checkAgentLatestVersion\(item\.productId\)/)
  assert.match(page, /checkAgentLatestVersion\(item\.productId, \{ force: true \}\)/)
  assert.match(page, /versionComparison === 'newer'/)
  assert.match(page, /versionCheckFailed/)
  assert.doesNotMatch(page, /latestVersion\?\.status === 'ready' && methods\.length/)
})

test('全部智能体接入主行直接显示本机及线上版本，不再要求先展开或先进入概览', () => {
  assert.match(page, /className="integration-management-version-summary" role="status"/)
  assert.match(page, /managementPage\.versionInstalledShort/)
  assert.match(page, /managementPage\.versionLatestShort/)
  assert.match(page, /onlineVersionLabel/)
  assert.match(page, /versionComparison === 'newer' && <StatusBadge tone="warning">/)
  assert.match(page, /versionCheckFailedShort/)
  assert.match(page, /versionCheckUnsupportedShort/)
  assert.match(page, /snapshot\.agentSummaries\.items\.find\(agent => agent\.productId === item\.productId\)/)
  assert.match(page, /managementVersionApi\.agentDetail\(source\.sourceId\)/)
  assert.doesNotMatch(page, /model\.ensureAgentDetail\(source\.sourceId\)/)
  assert.match(page, /\?\? installationVersions\[item\.productId\]/)
  assert.match(page, /item\.tool\?\.presence !== 'present'/)
  assert.match(integrationCss, /\.integration-management-version-summary \{/)
  assert.match(integrationCss, /\.integration-management-version-hint \{/)
  assert.match(integrationCss, /\.integration-management-disclosure > summary > \.ui-disclosure-meta/)
  assert.doesNotMatch(page, /latestVersion\?\.status === 'ready' && methods\.length/)
})

