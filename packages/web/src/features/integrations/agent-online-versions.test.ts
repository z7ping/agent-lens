import assert from 'node:assert/strict'
import test from 'node:test'
import { agentVersionComparison, checkAgentLatestVersion } from './agent-online-versions'

function success(version: string, key: 'version' | 'tag_name' = 'version') {
  return (async () => new Response(JSON.stringify({ [key]: version }), { status: 200 })) as typeof fetch
}

test('official package latest version is fetched from the explicitly allowlisted npm source', async () => {
  const urls: string[] = []
  const result = await checkAgentLatestVersion('pi', {
    force: true,
    fetchImpl: (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ version: '1.2.0' }), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.version, '1.2.0')
  assert.equal(result.source, 'npm')
  assert.deepEqual(urls, ['https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent/latest'])
})

test('online version comparisons never fabricate updates from missing, mixed or incompatible version schemas', () => {
  const remote = { status: 'ready', version: '1.2.0', source: 'npm' } as const
  assert.equal(agentVersionComparison(['1.1.0'], remote), 'newer')
  assert.equal(agentVersionComparison(['1.2.0'], remote), 'current')
  assert.equal(agentVersionComparison(['1.3.0'], remote), 'current')
  assert.equal(agentVersionComparison([], remote), 'unknown')
  assert.equal(agentVersionComparison(['1.0.0', '1.2.0'], remote), 'unknown')
  assert.equal(agentVersionComparison(['unavailable'], remote), 'unknown')
  assert.equal(agentVersionComparison(['0.21.3'], { ...remote, source: 'github', version: 'v2026.9.14' }), 'unknown')
  assert.equal(agentVersionComparison(['1.0.0'], { status: 'error' }), 'unknown')
  assert.equal(agentVersionComparison(['1.0.0'], null), 'unknown')
})

test('Hermes latest published tag is informational only, not compared to the CLI version', async () => {
  const result = await checkAgentLatestVersion('hermes', { force: true, fetchImpl: success('v2026.9.14', 'tag_name') })
  assert.equal(result.source, 'github')
  assert.equal(result.version, 'v2026.9.14')
  assert.equal(agentVersionComparison(['0.21.3'], result), 'unknown')
})

test('failed network check and unsupported agent leave a distinct unknown status', async () => {
  const result = await checkAgentLatestVersion('codex', {
    force: true,
    fetchImpl: (async () => { throw new Error('offline') }) as typeof fetch,
  })
  assert.equal(result.status, 'error')
  assert.equal(agentVersionComparison(['0.2.0'], result), 'unknown')
  assert.deepEqual(await checkAgentLatestVersion('dsh'), { status: 'unsupported' })
})

test('version checks are cached, and a deliberate refresh bypasses a prior successful cache', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 })
  }) as typeof fetch
  await checkAgentLatestVersion('opencode', { force: true, fetchImpl, now: 500 })
  await checkAgentLatestVersion('opencode', { fetchImpl, now: 600 })
  assert.equal(calls, 1)
  await checkAgentLatestVersion('opencode', { force: true, fetchImpl, now: 700 })
  assert.equal(calls, 2)
})
