import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeStorageBudgetUsage,
  isStorageBudgetPolicy,
  storageBudgetPreset,
} from './storage-budget'

test('平衡预设提供 Hot 与 Total 的高低水位，并保持 Total 不小于 Hot', () => {
  const policy = storageBudgetPreset()
  assert.equal(policy.preset, 'balanced')
  assert.equal(policy.hot.highBytes, 2 * 1024 * 1024 * 1024)
  assert.equal(policy.hot.lowBytes, 1536 * 1024 * 1024)
  assert.equal(policy.total.highBytes, 4 * 1024 * 1024 * 1024)
  assert.equal(policy.total.lowBytes, 3 * 1024 * 1024 * 1024)
  assert.equal(isStorageBudgetPolicy(policy), true)
})

test('预算策略拒绝倒置或不安全的水位', () => {
  assert.equal(isStorageBudgetPolicy({
    ...storageBudgetPreset(),
    hot: { lowBytes: 2, highBytes: 2 },
  }), false)
  assert.equal(isStorageBudgetPolicy({
    ...storageBudgetPreset(),
    total: { lowBytes: 1, highBytes: 2 },
  }), false)
})

test('高低水位在低水位以下恢复健康，高水位触发超限', () => {
  const watermarks = storageBudgetPreset().hot
  assert.equal(describeStorageBudgetUsage(watermarks.lowBytes - 1, watermarks).state, 'healthy')
  assert.equal(describeStorageBudgetUsage(watermarks.lowBytes, watermarks).state, 'approaching')
  assert.equal(describeStorageBudgetUsage(watermarks.highBytes, watermarks).state, 'exceeded')
})
