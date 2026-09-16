import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const agentsPage = readFileSync(new URL('../AgentsPage.tsx', import.meta.url), 'utf8')
const onboarding = readFileSync(new URL('../IntegrationOnboarding.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const zhAgents = readFileSync(new URL('../../i18n/zh-CN/agents.ts', import.meta.url), 'utf8')

test('智能体接入页面以 Integration Management 为管理清单，不读取 Source Facet', () => {
  assert.match(page, /snapshot\.integrationManagement/)
  assert.doesNotMatch(page, /snapshot\.facets/)
  assert.doesNotMatch(page, /facets\?\.agents/)
})

test('智能体接入页面控件继续使用统一 Workspace Topbar', () => {
  assert.match(app, /topbarHost=\{workspaceTopbarHost\}/)
  assert.match(page, /createPortal/)
  assert.match(page, /<ToolbarGroup className="integration-management-topbar-tools">/)
})

test('设置菜单持有稳定的智能体接入入口与独立路由', () => {
  assert.match(sidebar, /navigate\('\/integrations'\)/)
  assert.match(sidebar, /navigation:agentIntegration/)
  assert.match(app, /<Route path="\/integrations"/)
  assert.match(app, /pathname\.startsWith\('\/integrations'\)/)
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

test('智能体页选择器合并 Overview 与已发现 Integration，不再只等于 Source Facet', () => {
  assert.match(app, /const agentSelectionMap = new Map<string, AgentFacetDto>/)
  assert.match(app, /management\.tool\?\.presence === 'present'/)
  assert.match(app, /management\.tool\?\.presence === 'data-only'/)
  assert.match(app, /agentSelectionAgents=\{agentSelectionItems\}/)
  assert.match(sidebar, /agents=\{agentSelectionAgents\}/)
  assert.match(sidebar, /navigation:agentCount/)
  assert.doesNotMatch(sidebar, /sourceCount[^\n]*agentSelectionAgents/)
})

test('未启用但已发现的智能体保持可见并支持二次接入', () => {
  assert.match(page, /item\.tool\?\.presence === 'present'/)
  assert.match(page, /item\.tool\?\.presence === 'data-only'/)
  assert.match(page, /managementPage\.add/)
  assert.match(page, /status\.notAdded/)
})


test('首次未选择的本机智能体仍可在智能体页二次接入', () => {
  assert.match(app, /agentSelectionAgents=\{agentSelectionItems\}/)
  assert.match(agentsPage, /const managedRows = managementItems\.map/)
  assert.match(agentsPage, /<IntegrationOnlyCard/)
  assert.match(agentsPage, /model\.installIntegration/)
  assert.match(agentsPage, /model\.setIntegrationEnabled/)
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

test('扫描失败与 data-only 保持独立语义', () => {
  assert.match(page, /integrationToolPresenceLabel/)
  assert.match(page, /toolPresence\.dataOnlyHint/)
  assert.match(app, /status\.scanFailed/)
})


test('智能体页刷新同时重扫 Integration Discovery，允许运行中安装的新 Agent 出现', () => {
  assert.match(app, /onRefreshAgents=\{\(\) => \{ void Promise\.allSettled\(\[model\.rescanIntegrationDiscovery\(\), model\.refreshFacetsAndAgents\(\)\]\) \}\}/)
})

test('接入页把本机发现状态与接入启停状态分开表达', () => {
  assert.match(page, /const discoveredStatus = integrationLifecycleState/)
  assert.match(page, /managementPage\.enabledTitle/)
  assert.match(page, /managementPage\.disabledTitle/)
  assert.match(page, /initialNewIdsRef/)
  assert.match(page, /model\.acknowledgeIntegration/)
})

test('首次未发现时明确指向设置中的二次接入入口', () => {
  assert.match(zhAgents, /设置 → 智能体接入/)
})
