import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const zhAgents = readFileSync(new URL('../../i18n/zh-CN/agents.ts', import.meta.url), 'utf8')

test('智能体接入页面以 Integration Management 为管理清单，不读取 Source Facet', () => {
  assert.match(page, /snapshot\.integrationManagement/)
  assert.doesNotMatch(page, /snapshot\.facets/)
  assert.doesNotMatch(page, /facets\?\.agents/)
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

test('未启用但已发现的智能体保持可见并支持二次接入', () => {
  assert.match(page, /item\.tool\?\.presence === 'present'/)
  assert.match(page, /item\.tool\?\.presence === 'data-only'/)
  assert.match(page, /managementPage\.add/)
  assert.match(page, /status\.notAdded/)
})

test('扫描失败与 data-only 保持独立语义', () => {
  assert.match(page, /integrationToolPresenceLabel/)
  assert.match(page, /toolPresence\.dataOnlyHint/)
  assert.match(app, /status\.scanFailed/)
})

test('首次未发现时明确指向设置中的二次接入入口', () => {
  assert.match(zhAgents, /设置 → 智能体接入/)
})
