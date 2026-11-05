import assert from 'node:assert/strict'
import test from 'node:test'
import { agentWorkDeliveryKey, agentWorkExecutionStatusKey, visibleAgentWorkExecutions } from './agent-work-execution-label'

test('observed Hermes cron statuses and delivery outcomes have separate localizable labels', () => {
  assert.equal(agentWorkExecutionStatusKey('completed'), 'work.executionCompleted')
  assert.equal(agentWorkExecutionStatusKey('failed'), 'work.executionFailed')
  assert.equal(agentWorkExecutionStatusKey('running'), 'work.executionRunning')
  assert.equal(agentWorkDeliveryKey('suppressed'), 'work.deliverySuppressed')
  assert.equal(agentWorkDeliveryKey('delivered'), 'work.deliveryDelivered')
  assert.equal(agentWorkDeliveryKey('failed'), 'work.deliveryFailed')
  assert.equal(agentWorkDeliveryKey('unverified'), undefined)
  assert.equal(agentWorkExecutionStatusKey('unverified'), undefined)
})

test('native execution list stays in server order and initially renders only the first five', () => {
  const source = Array.from({ length: 32 }, (_, id) => ({ id }))
  assert.deepEqual(visibleAgentWorkExecutions(source, false).map(x => x.id), [0,1,2,3,4])
  assert.equal(visibleAgentWorkExecutions(source, true).length, 32)
  assert.equal(visibleAgentWorkExecutions([], false).length, 0)
  assert.equal(source.length, 32)
})
