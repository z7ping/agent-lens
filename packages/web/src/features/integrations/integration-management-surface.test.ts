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

test('智能体接入使用连续数据面，不恢复重复标题或逐项卡片', () => {
  assert.match(page, /className="integration-management-surface"/)
  assert.match(page, /className="integration-management-table-head"/)
  assert.doesNotMatch(page, /<h1/)
  assert.match(integrationCss, /\.integration-management-surface\s*\{[\s\S]*?border:\s*1px solid var\(--al-line\);[\s\S]*?background:\s*var\(--al-surface\);/)
  assert.match(integrationCss, /\.integration-management-summary\s*\{[\s\S]*?background:\s*var\(--al-soft-2\);/)
  assert.match(integrationCss, /@media \(max-width: 1199\.98px\)/)
  assert.match(integrationCss, /@media \(max-width: 991\.98px\)/)
  assert.match(integrationCss, /@media \(max-width: 767\.98px\)/)
  assert.doesNotMatch(integrationCss, /!important/)
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
  assert.match(page, /item\.tool\?\.presence === 'present'/)
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
