import assert from 'node:assert/strict'
import test from 'node:test'
import { lifecycleEventLabel } from './index'

test('ReviewProjection localizes persisted subagent and reasoning configuration activities', () => {
  assert.equal(lifecycleEventLabel({ event: 'subagent.communication' }), '子 Agent 通信')
  assert.equal(lifecycleEventLabel({ event: 'reasoning.configuration.updated' }), '推理配置更新')
})
