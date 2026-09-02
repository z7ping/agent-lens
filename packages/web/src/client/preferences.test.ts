import assert from 'node:assert/strict'
import test from 'node:test'
import { readAgentFilterPreference, writeAgentFilterPreference } from './preferences'

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
