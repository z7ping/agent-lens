import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { storageBudgetPreset } from '@agent-lens/core'
import {
  readStorageBudgetConfiguration,
  resolveStorageBudgetPolicy,
  storageBudgetConfigurationPath,
  writeStorageBudgetConfiguration,
} from './storage-budget-configuration'

test('存储预算使用用户级稳定配置路径', () => {
  assert.match(storageBudgetConfigurationPath({}), /\.agent-lens[\\/]1\.0[\\/]config[\\/]storage-budget\.json$/)
  assert.equal(storageBudgetConfigurationPath({ AGENT_LENS_STORAGE_BUDGET_PATH: 'D:\\budget.json' }), 'D:\\budget.json')
})

test('存储预算原子持久化，并由配置覆盖平衡默认值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-storage-budget-'))
  const path = join(root, 'nested', 'storage-budget.json')
  try {
    const policy = storageBudgetPreset('full-retention')
    await writeStorageBudgetConfiguration(path, policy)
    assert.deepEqual((await readStorageBudgetConfiguration(path))?.policy, policy)
    assert.deepEqual(resolveStorageBudgetPolicy({ AGENT_LENS_STORAGE_BUDGET_PATH: path }).policy, policy)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
