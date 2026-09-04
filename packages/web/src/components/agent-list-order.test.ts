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
    './WorkspaceSidebar.tsx',
    '../features/AgentsPage.tsx',
    '../features/BackupPage.tsx',
    '../features/InsightsPage.tsx',
    '../features/TaskCenterPage.tsx',
    '../features/ToolsPage.tsx',
  ]

  for (const consumer of consumers) {
    const source = readFileSync(new URL(consumer, import.meta.url), 'utf8')
    assert.match(source, /useOrderedAgents\(/, `${consumer} 必须使用统一智能体排序`)
  }
})
