import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PiRpcClient, StrictJsonlDecoder } from './rpc-client'

test('StrictJsonlDecoder 只以 LF 分帧并保留 Unicode 行分隔符', () => {
  const decoder = new StrictJsonlDecoder()
  const value = JSON.stringify({ text: 'a\u2028b\u2029c' })
  const first = Buffer.from(value.slice(0, 8))
  const second = Buffer.from(`${value.slice(8)}\r\n`)
  assert.deepEqual(decoder.push(first), [])
  assert.deepEqual(decoder.push(second), [value])
})

test('PiRpcClient 关联 command response，同时转发异步事件', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-rpc.mjs', import.meta.url))
  const events: Record<string, unknown>[] = []
  const client = new PiRpcClient({
    executable: process.execPath,
    cwd: process.cwd(),
    launchPrefixArgs: [fixture],
    commandTimeoutMs: 2_000,
    onEvent: event => events.push(event),
  })
  await client.start()
  try {
    const response = await client.command({ type: 'get_state' })
    assert.equal(response.success, true)
    assert.equal(response.command, 'get_state')

    await client.command({ type: 'prompt', message: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(events.some(event => event.type === 'message_update'), true)
    assert.equal(events.some(event => event.type === 'agent_settled'), true)

    client.send({ type: 'extension_ui_response', id: 'extension-1', confirmed: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    const extension = events.find(event => event.type === 'fixture_extension_seen')
    assert.equal(extension?.id, 'extension-1')
    assert.equal(extension?.confirmed, true)
  } finally {
    await client.close()
  }
})
