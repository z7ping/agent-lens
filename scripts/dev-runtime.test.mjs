import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildDevEnvironment,
  devRuntimePaths,
  findAvailableDevPort,
  npmInvocation,
  parseDevPort,
} from './dev-runtime.mjs'

test('parseDevPort 使用默认端口并拒绝非法值', () => {
  assert.equal(parseDevPort(undefined), 56789)
  assert.equal(parseDevPort('56820'), 56820)
  assert.throws(() => parseDevPort('0'), /1-65535/)
  assert.throws(() => parseDevPort('abc'), /1-65535/)
})

test('findAvailableDevPort 从起始端口逐个 +1', async () => {
  const probed = []
  const selected = await findAvailableDevPort(56789, 5, async port => {
    probed.push(port)
    return port === 56791
  })

  assert.equal(selected, 56791)
  assert.deepEqual(probed, [56789, 56790, 56791])
})

test('findAvailableDevPort 在范围耗尽时明确失败', async () => {
  await assert.rejects(
    findAvailableDevPort(56789, 3, async () => false),
    /56789-56791 均不可用/,
  )
})

test('开发数据按端口隔离且不复用正式数据目录', () => {
  const repoRoot = join('workspace', 'agent-lens')
  const first = devRuntimePaths(repoRoot, 56789)
  const second = devRuntimePaths(repoRoot, 56790)

  assert.equal(first.dataRoot, join(repoRoot, '.agent-lens', 'dev', '56789'))
  assert.equal(second.dataRoot, join(repoRoot, '.agent-lens', 'dev', '56790'))
  assert.notEqual(first.dbPath, second.dbPath)
  assert.notEqual(first.vaultPath, second.vaultPath)
})

test('buildDevEnvironment 覆盖正式运行时路径和端口', () => {
  const repoRoot = join('workspace', 'agent-lens')
  const env = buildDevEnvironment({ AGENT_LENS_PORT: '56789' }, repoRoot, 56790)
  const paths = devRuntimePaths(repoRoot, 56790)

  assert.equal(env.AGENT_LENS_PORT, '56790')
  assert.equal(env.AGENT_LENS_DB_PATH, paths.dbPath)
  assert.equal(env.AGENT_LENS_VAULT_PATH, paths.vaultPath)
  assert.equal(env.AGENT_LENS_DAEMON_MODE, 'foreground')
  assert.equal(env.AGENT_LENS_RUNTIME_OWNER, 'cli')
})

test('npmInvocation 优先通过当前 Node 复用 npm_execpath', () => {
  const invocation = npmInvocation({ npm_execpath: 'C:/node/npm-cli.js' })

  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [
    'C:/node/npm-cli.js',
    'run',
    'dev',
    '--workspace',
    '@agent-lens/daemon',
  ])
})
