import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readAgentFilterPreference,
  readAgentVisibilityPreference,
  readLegacyAgentOrderPreference,
  readSidebarCollapsed,
  writeAgentFilterPreference,
  writeAgentVisibilityPreference,
  writeSidebarCollapsed,
} from './preferences'

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key: string) { return values.get(key) ?? null },
    setItem(key: string, value: string) { values.set(key, value) },
  }
}

test('智能体筛选偏好兼容旧快捷项顺序', () => {
  const previous = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage({ 'agent-lens.pinned-agents.v1': '["codex","pi"]' }) })
  try {
    assert.deepEqual(readAgentFilterPreference(), { orderedAgentIds: ['codex', 'pi'], visibleAgentIds: ['codex', 'pi'] })
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous })
  }
})

test('智能体筛选偏好分别保存顺序和工具栏显示项并去重', () => {
  const previous = globalThis.localStorage
  const memory = storage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory })
  try {
    writeAgentFilterPreference({ orderedAgentIds: ['pi', 'codex', 'pi'], visibleAgentIds: ['codex', 'codex'] })
    assert.deepEqual(readAgentFilterPreference(), { orderedAgentIds: ['pi', 'codex'], visibleAgentIds: ['codex'] })
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous })
  }
})

test('浏览器快捷显示偏好不再写回全局智能体顺序', () => {
  const previous = globalThis.localStorage
  const memory = storage({
    'agent-lens.agent-filter.v2': JSON.stringify({
      orderedAgentIds: ['codex', 'pi'],
      visibleAgentIds: ['codex', 'pi'],
    }),
  })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory })
  try {
    assert.deepEqual(readLegacyAgentOrderPreference(), ['codex', 'pi'])
    writeAgentVisibilityPreference({ visibleAgentIds: ['pi'] })
    assert.deepEqual(readAgentVisibilityPreference(), { visibleAgentIds: ['pi'] })
    assert.deepEqual(readLegacyAgentOrderPreference(), ['codex', 'pi'])
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous })
  }
})

test('桌面侧栏收起状态可以持久化并安全恢复默认值', () => {
  const previous = globalThis.localStorage
  const memory = storage()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory })
  try {
    assert.equal(readSidebarCollapsed(), false)
    writeSidebarCollapsed(true)
    assert.equal(readSidebarCollapsed(), true)
    writeSidebarCollapsed(false)
    assert.equal(readSidebarCollapsed(), false)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous })
  }
})
