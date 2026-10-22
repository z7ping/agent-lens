import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the actual Worker implementation with a mocked official endpoint.
// No external network is involved and the installed Pi binary is untouched.
const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const start = worker.indexOf('const PI_LATEST_VERSION_URL')
const end = worker.indexOf('function startupResourceSnapshot(', start)
assert.ok(start >= 0 && end > start)
const implementation = worker.slice(start, end)

function harness(options: {
  installed?: string
  latest?: string
  offline?: boolean
  failed?: boolean
  skip?: boolean
} = {}) {
  const events: Array<{ type: string; status: string; latestVersion?: string }> = []
  let calls = 0
  const sandbox = {
    AbortSignal,
    Date,
    process: { env: {
      ...(options.skip ? { PI_SKIP_VERSION_CHECK: '1' } : {}),
    } },
    record: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    piOfflineModeEnabled: () => options.offline === true,
    fetch: async (_url: string, _options: unknown) => {
      calls += 1
      if (options.failed) throw new Error('offline endpoint')
      return { ok: true, json: async () => ({ version: options.latest ?? '1.4.0' }) }
    },
    send: (_kind: string, event: { type: string; status: string; latestVersion?: string }) => events.push(event),
  }
  const program = [
    `let sdkVersion = ${JSON.stringify(options.installed ?? '1.2.0')}`,
    'let piVersionCheck = "unavailable"',
    'let piLatestVersion',
    'let piVersionCheckedAt',
    'let terminating = false',
    implementation,
    '({ newerPiVersion, startPiVersionCheck, state: () => ({ piVersionCheck, piLatestVersion, piVersionCheckedAt }) })',
  ].join('\n')
  const api = runInNewContext(program, sandbox) as {
    newerPiVersion(candidate: string, current: string): boolean
    startPiVersionCheck(): void
    state(): { piVersionCheck: string; piLatestVersion?: string; piVersionCheckedAt?: string }
  }
  return { api, events, calls: () => calls }
}

test('Pi official semantic versions only announce strictly newer releases', () => {
  const { api } = harness()
  assert.equal(api.newerPiVersion('1.4.0', '1.2.0'), true)
  assert.equal(api.newerPiVersion('1.2.0', '1.4.0'), false)
  assert.equal(api.newerPiVersion('1.2.0', '1.2.0'), false)
  assert.equal(api.newerPiVersion('1.2.0', '1.2.0-alpha.2'), true)
  assert.equal(api.newerPiVersion('1.2.0-alpha.2', '1.2.0'), false)
  assert.equal(api.newerPiVersion('1.2.0-alpha.10', '1.2.0-alpha.2'), true)
  assert.equal(api.newerPiVersion('unverified', '1.2.0'), false)
})

test('Pi update check is asynchronous, does not perform installation, and reports newer version', async () => {
  const value = harness({ installed: '1.2.0', latest: '1.4.0' })
  value.api.startPiVersionCheck()
  assert.equal(value.api.state().piVersionCheck, 'checking')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(value.calls(), 1)
  assert.equal(value.api.state().piVersionCheck, 'complete')
  assert.equal(value.api.state().piLatestVersion, '1.4.0')
  assert.equal(value.events[0]?.type, 'pi_version_check')
})

test('Pi offline/skip and failed checks never invent an available update', async () => {
  for (const disabled of [harness({ offline: true }), harness({ skip: true })]) {
    disabled.api.startPiVersionCheck()
    assert.equal(disabled.api.state().piVersionCheck, 'unavailable')
    assert.equal(disabled.calls(), 0)
  }
  const unavailable = harness({ failed: true })
  unavailable.api.startPiVersionCheck()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(unavailable.api.state().piVersionCheck, 'failed')
  assert.equal(unavailable.api.state().piLatestVersion, undefined)
})
