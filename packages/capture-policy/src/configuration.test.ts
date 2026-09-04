import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  capturePolicyConfigurationPath,
  readCapturePolicyConfiguration,
  readCapturePolicyConfigurationSync,
  writeCapturePolicyConfiguration,
} from './configuration'

test('用户级采集配置使用稳定路径并可通过环境覆盖测试位置', () => {
  assert.equal(
    capturePolicyConfigurationPath({ AGENT_LENS_CAPTURE_POLICY_PATH: 'D:\\tmp\\capture.json' }),
    'D:\\tmp\\capture.json',
  )
  assert.match(capturePolicyConfigurationPath({}), /\.agent-lens[\\/]1\.0[\\/]config[\\/]capture-policy\.json$/)
})

test('用户级采集配置原子写入并规范化来源 ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-capture-policy-'))
  const path = join(root, 'nested', 'capture-policy.json')
  try {
    const saved = await writeCapturePolicyConfiguration(path, [' Codex ', 'PI', 'codex'])
    assert.deepEqual(saved.enabledSources, ['codex', 'pi'])
    assert.deepEqual((await readCapturePolicyConfiguration(path))?.enabledSources, ['codex', 'pi'])
    assert.deepEqual(readCapturePolicyConfigurationSync(path)?.enabledSources, ['codex', 'pi'])
    assert.match(await readFile(path, 'utf8'), /"version": 1/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('损坏或未知版本配置安全回退为未配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-capture-policy-invalid-'))
  const path = join(root, 'capture-policy.json')
  try {
    await writeFile(path, '{broken', 'utf8')
    assert.equal(await readCapturePolicyConfiguration(path), null)
    await writeFile(path, JSON.stringify({ version: 2, enabledSources: ['codex'] }), 'utf8')
    assert.equal(readCapturePolicyConfigurationSync(path), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
