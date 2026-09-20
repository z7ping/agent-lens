import assert from 'node:assert/strict'
import test from 'node:test'
import { taskTurnFinalAssistantIndexes, type TaskTurnSemanticKind } from './task-turn-presentation'

test('最终 Assistant 只来自最后一个明确处理事实之后', () => {
  const items: TaskTurnSemanticKind[] = ['prompt', 'assistant', 'process', 'meta', 'assistant', 'assistant', 'artifact']
  assert.deepEqual([...taskTurnFinalAssistantIndexes(items, item => item)], [4, 5])
})

test('没有后续 Assistant 时不伪造最终输出', () => {
  const items: TaskTurnSemanticKind[] = ['prompt', 'assistant', 'process', 'meta']
  assert.deepEqual([...taskTurnFinalAssistantIndexes(items, item => item)], [])
})
