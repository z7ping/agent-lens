import assert from 'node:assert/strict'
import test from 'node:test'
import { nextAgentFilterSelection } from './task-agent-selection'

const detected = ['pi', 'codex', 'hermes'] as const

test('默认全部 -> 点击 Pi 仅 Pi -> 再点 Codex 得 Pi + Codex', () => {
  const pi = nextAgentFilterSelection(null, 'pi', detected)
  assert.deepEqual(pi, ['pi'])
  const both = nextAgentFilterSelection(pi, 'codex', detected)
  assert.deepEqual(both, ['pi', 'codex'])
  assert.deepEqual(nextAgentFilterSelection(both, 'pi', detected), ['codex'])
})

test('取消最后一个勾选得到显式空集，不暗中变回全部', () => {
  assert.deepEqual(nextAgentFilterSelection(['pi'], 'pi', detected), [])
  assert.deepEqual(nextAgentFilterSelection([], 'codex', detected), ['codex'])
  assert.equal(nextAgentFilterSelection(null, 'unknown', detected), null)
  assert.deepEqual(nextAgentFilterSelection(['pi'], 'unknown', detected), ['pi'])
})

test('用户明确点击「全部」恢复 null 语义（调用方 reset），不擅自把全选列表归一化', () => {
  assert.deepEqual(nextAgentFilterSelection(['pi', 'codex'], 'hermes', detected), ['pi', 'codex', 'hermes'])
})
