import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildDevEnvironment,
  devRuntimePaths,
  findAvailableDevPort,
  npmInvocation,
  parseDevPort,
  waitForRuntimeReady,
} from './dev-runtime.mjs'

test('parseDevPort 使用默认端口并拒绝非法值', () => {
  assert.equal(parseDevPort(undefined), 56800)
  assert.equal(parseDevPort('56820'), 56820)
  assert.throws(() => parseDevPort('0'), /1-65535/)
  assert.throws(() => parseDevPort('abc'), /1-65535/)
})

test('源码开发默认端口与安装态 56789 保持隔离', () => {
  assert.notEqual(parseDevPort(undefined), 56789)
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

test('buildDevEnvironment 同时配置 Daemon 与 Vite 代理端口', () => {
  const repoRoot = join('workspace', 'agent-lens')
  const env = buildDevEnvironment({ AGENT_LENS_PORT: '56789' }, repoRoot, 56790)
  const paths = devRuntimePaths(repoRoot, 56790)

  assert.equal(env.AGENT_LENS_PORT, '56790')
  assert.equal(env.AGENT_LENS_DEV_API_PORT, '56790')
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

test('npmInvocation 可启动源码 Web workspace', () => {
  const invocation = npmInvocation({ npm_execpath: 'C:/node/npm-cli.js' }, '@agent-lens/web')

  assert.equal(invocation.command, process.execPath)
  assert.deepEqual(invocation.args, [
    'C:/node/npm-cli.js',
    'run',
    'dev',
    '--workspace',
    '@agent-lens/web',
  ])
})

test('开发 Web 等待 Runtime Health 成功后再继续启动', async () => {
  let attempts = 0
  await waitForRuntimeReady('http://127.0.0.1:56800/api/v1/ready', {
    intervalMs: 0,
    timeoutMs: 1_000,
    async fetchImpl() {
      attempts += 1
      if (attempts < 3) throw new Error('ECONNREFUSED')
      return { ok: true, status: 200 }
    },
  })

  assert.equal(attempts, 3)
})

test('Runtime Health 持续失败时给出明确超时', async () => {
  await assert.rejects(
    waitForRuntimeReady('http://127.0.0.1:56800/api/v1/ready', {
      intervalMs: 0,
      timeoutMs: 10,
      async fetchImpl() { throw new Error('ECONNREFUSED') },
    }),
    /Runtime 在 10ms 内未就绪：ECONNREFUSED/,
  )
})
