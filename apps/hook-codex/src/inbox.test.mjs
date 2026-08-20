import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  neutralHookOutput,
  persistCodexHookEvent,
} from './inbox.mjs'

test('Codex hook persists one sanitized durable inbox event', async () => {
  const inbox = await mkdtemp(join(tmpdir(), 'agent-lens-hook-codex-'))
  try {
    await persistCodexHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      call_id: 'call-1',
      tool_name: 'shell_command',
      tool_input: {
        command: 'npm test',
        api_key: 'should-not-be-written',
      },
    }, { inboxDir: inbox })

    const files = await readdir(inbox)
    assert.equal(files.length, 1)
    const file = files[0]
    assert.ok(file)
    assert.equal(file.endsWith('.json'), true)

    const envelope = JSON.parse(
      await readFile(join(inbox, file), 'utf8'),
    )
    assert.equal(envelope.event.hook_event_name, 'PreToolUse')
    assert.equal(envelope.event.call_id, 'call-1')
    assert.equal(envelope.event.tool_input.command, 'npm test')
    assert.equal(envelope.event.tool_input.api_key, '[redacted]')
  } finally {
    await rm(inbox, { recursive: true, force: true })
  }
})

test('Codex stop-style hooks preserve neutral output semantics', () => {
  assert.equal(neutralHookOutput('Stop'), '{}')
  assert.equal(neutralHookOutput('SubagentStop'), '{}')
  assert.equal(neutralHookOutput('PreToolUse'), '')
})
