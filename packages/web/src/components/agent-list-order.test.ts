import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { orderAgentsByPreference } from './agent-order'

test('统一智能体列表遵循用户顺序并在末尾保留新来源', () => {
  const agents = [
    { sourceId: 'claude-code' },
    { sourceId: 'codex' },
    { sourceId: 'pi' },
    { sourceId: 'hermes' },
  ]

  assert.deepEqual(
    orderAgentsByPreference(agents, ['pi', 'codex', 'missing']).map(agent => agent.sourceId),
    ['pi', 'codex', 'claude-code', 'hermes'],
  )
})

test('统一智能体列表忽略已移除来源且不会重复项目', () => {
  const agents = [{ sourceId: 'codex' }, { sourceId: 'pi' }]

  assert.deepEqual(
    orderAgentsByPreference(agents, ['pi', 'pi', 'removed']).map(agent => agent.sourceId),
    ['pi', 'codex'],
  )
})

test('所有智能体展示列表统一消费用户排序', () => {
  const consumers = [
    './AgentInsightsRail.tsx',
    '../features/AgentsPage.tsx',
    '../features/InsightsPage.tsx',
    '../features/TaskCenterPage.tsx',
    '../features/ToolsPage.tsx',
  ]

  for (const consumer of consumers) {
    const source = readFileSync(new URL(consumer, import.meta.url), 'utf8')
    assert.match(source, /useOrderedAgents\(/, `${consumer} 必须使用统一智能体排序`)
  }

  const sidebarFilter = readFileSync(new URL('./SidebarFilterDisclosure.tsx', import.meta.url), 'utf8')
  assert.match(sidebarFilter, /useOrderedAgents\(agents\)/, '左侧平铺智能体筛选必须统一消费用户排序')
  assert.match(sidebarFilter, /agentOrderManagement/, '左侧智能体上下文必须提供排序管理能力')
  assert.doesNotMatch(sidebarFilter, /<Disclosure[^>]*\sopen(?:\s|>)/, '统一侧栏筛选默认必须收起')

  const integrationManagement = readFileSync(new URL('../features/IntegrationManagementPage.tsx', import.meta.url), 'utf8')
  assert.match(integrationManagement, /useIntegrationOrder\(\)/, '接入管理继续消费统一用户排序')
  assert.match(integrationManagement, /setOrdering\(value => !value\)/, '接入管理必须公开排序入口')
  assert.match(integrationManagement, /ordering \? <section className="integration-management-section"/, '排序必须使用独立的列表模式')
  const sharedOrder = readFileSync(new URL('./AgentOrderControls.tsx', import.meta.url), 'utf8')
  assert.match(integrationManagement, /<AgentOrderActions sourceId=\{item\.integrationId\}/, '排序模式复用统一上下移动作')
  assert.match(integrationManagement, /\.\.\.dragProps\(item\.integrationId\)/, '排序模式复用统一拖拽契约')
  assert.match(sharedOrder, /onClick=\{\(\) => moveBy\(sourceId, -1\)\}/, '排序组件提供上移能力')
  assert.match(sharedOrder, /onDrop: \(event: DragEvent<HTMLDivElement>\) =>/, '排序组件提供拖动能力')
  assert.doesNotMatch(integrationManagement, /moveUpTargetId/, '不允许将排序动作藏在详情中')
  const agentsWorkspace = readFileSync(new URL('../features/AgentsResponsivePage.tsx', import.meta.url), 'utf8')
  assert.match(agentsWorkspace, /useOrderedAgents\(agents\)/, '智能体概览选择器沿用用户排序')

  const agentsPage = readFileSync(new URL('../features/AgentsPage.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(agentsPage, /agent-source-nav/, '智能体正文不得保留被工作栏替代的来源导航')
})
