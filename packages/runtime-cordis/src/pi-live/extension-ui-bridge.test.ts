import assert from 'node:assert/strict'
import test from 'node:test'
import { PiExtensionUiBridge } from './extension-ui-bridge'

function requestIds(events: ReadonlyArray<Record<string, unknown>>): string[] {
  return events.filter(event => event.type === 'extension_ui_request'
    && event.method === 'confirm').map(event => String(event.id))
}

test('two pending Pi extension dialogs can resolve independently', async () => {
  const events: Record<string, unknown>[] = []
  const bridge = new PiExtensionUiBridge({ publish: event => { events.push(event) } })
  const first = bridge.context.confirm('A', 'Approve A?')
  const second = bridge.context.confirm('B', 'Approve B?')
  const [idA, idB] = requestIds(events)
  assert.ok(idA && idB && idA !== idB)

  // A later request can settle before the first without losing either.
  assert.equal(bridge.respond(idB, { confirmed: true }), true)
  assert.equal(await second, true)
  assert.equal(bridge.respond(idB, { confirmed: true }), false)
  assert.equal(bridge.respond(idA, { confirmed: false }), true)
  assert.equal(await first, false)
  assert.deepEqual(events.filter(event => event.type === 'extension_ui_dismissed')
    .map(event => event.requestId), [idB, idA])
  bridge.dispose()
})

test('Pi extension request abort and expiry remove only the matching request', async () => {
  const events: Record<string, unknown>[] = []
  const bridge = new PiExtensionUiBridge({ publish: event => { events.push(event) } })
  const abort = new AbortController()
  const first = bridge.context.confirm('A', 'Approve A?', { signal: abort.signal })
  const second = bridge.context.confirm('B', 'Approve B?')
  const [idA, idB] = requestIds(events)
  assert.ok(idA && idB)
  abort.abort()
  assert.equal(await first, false)
  assert.equal(bridge.respond(idA, { confirmed: true }), false)
  assert.equal(bridge.respond(idB, { confirmed: true }), true)
  assert.equal(await second, true)
  assert.deepEqual(events.filter(event => event.type === 'extension_ui_dismissed')
    .map(event => event.requestId), [idA, idB])

  const expired = bridge.context.confirm('Timeout', 'Approve?', { timeout: 5 })
  const [idC] = requestIds(events).slice(-1)
  assert.equal(await expired, false)
  assert.equal(bridge.respond(idC!, { confirmed: true }), false)
  assert.equal(events.filter(event => event.type === 'extension_ui_dismissed'
    && event.requestId === idC).length, 1)
  bridge.dispose()
})

test('disposing the bridge closes remaining native prompts', async () => {
  const events: Record<string, unknown>[] = []
  const bridge = new PiExtensionUiBridge({ publish: event => { events.push(event) } })
  const first = bridge.context.confirm('A', 'A?')
  const second = bridge.context.confirm('B', 'B?')
  const ids = requestIds(events)
  bridge.dispose()
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.deepEqual(events.filter(event => event.type === 'extension_ui_dismissed')
    .map(event => event.requestId), ids)
})

test('Pi custom terminal UI rejects unsupported Web interaction instead of reporting success', async () => {
  const bridge = new PiExtensionUiBridge({ publish: () => {} })
  await assert.rejects(
    () => bridge.context.custom(() => { throw new Error('should never render a terminal widget') }),
    /terminal custom UI is unavailable/,
  )
  bridge.dispose()
})

test('native command notifications and SDK failures are recorded without becoming chat messages', async () => {
  const events: Record<string, unknown>[] = []
  const bridge = new PiExtensionUiBridge({ publish: event => { events.push(event) } })
  const value = { command: '/extension', outcome: 'handled' as 'handled' | 'failed',
    startedAt: 'start', finishedAt: '', messages: [] as Array<{ level: 'info' | 'success' | 'warning' | 'error'; message: string }>,
    error: undefined as string | undefined }
  await bridge.runCommand('/extension', value, async () => {
    bridge.context.notify('original output', 'info')
    const id = bridge.captureCommandError({ extensionPath: 'command:extension', error: 'Failed safely' })
    assert.equal(typeof id, 'string')
  })
  assert.deepEqual(value.messages, [{ level: 'info', message: 'original output' }])
  assert.equal(value.outcome, 'failed')
  assert.equal(value.error, 'Failed safely')
  const notice = events.find(event => event.method === 'notify')
  assert.equal(typeof notice?.commandRecordId, 'string')
  assert.equal(notice?.message, 'original output')
  bridge.dispose()
})
