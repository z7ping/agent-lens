import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveTaskProjectionItem } from './live-task-projection'
import { visibleLiveToolIds } from './LiveToolGroup'

function tool(index: number, status: 'success' | 'running' | 'error' = 'success'): LiveTaskProjectionItem {
  return { id: `tool:${index}`, kind: 'tool', callId: `call:${index}`, name: 'shell', status }
}

test('少于六条工具默认全部外露，每条仍由 TaskToolRow 决定是否展开详情', () => {
  const items = [tool(1), tool(2), tool(3), tool(4), tool(5)]
  assert.equal(visibleLiveToolIds(items, false).size, 5)
})

test('大量并行工具只显示前三项以及所有运行中和失败项', () => {
  const items = [
    tool(1), tool(2), tool(3), tool(4), tool(5),
    tool(6, 'running'), tool(7), tool(8, 'error'), tool(9, 'running'),
  ]
  assert.deepEqual([...visibleLiveToolIds(items, false)], ['tool:1','tool:2','tool:3','tool:6','tool:8','tool:9'])
  assert.equal(visibleLiveToolIds(items, true).size, 9)
})

test('穿插 Thinking 不改变工具的可见顺序和分组计数', () => {
  const items: LiveTaskProjectionItem[] = [
    tool(1),
    { id: 'thinking:1', kind: 'thinking', text: '正在检查', streaming: false },
    tool(2),
    tool(3),
    tool(4),
    tool(5),
    tool(6, 'running'),
  ]
  assert.deepEqual([...visibleLiveToolIds(items, false)], ['tool:1','tool:2','tool:3','tool:6'])
})
