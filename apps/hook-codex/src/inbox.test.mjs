import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  enabledSources,
  neutralHookOutput,
  persistCodexHookEvent,
  sourceCaptureEnabled,
} from './inbox.mjs'

const unconfiguredEnv = {
  AGENT_LENS_CAPTURE_POLICY_PATH: join(tmpdir(), `agent-lens-hook-policy-unconfigured-${process.pid}.json`),
}

test('source collection defaults to Claude Code only', () => {
  assert.deepEqual(enabledSources(unconfiguredEnv), ['claude-code'])
  assert.equal(sourceCaptureEnabled('claude-code', unconfiguredEnv), true)
  assert.equal(sourceCaptureEnabled('codex', unconfiguredEnv), false)
  assert.equal(sourceCaptureEnabled('codex', { AGENT_LENS_ENABLED_SOURCES: 'claude-code,codex' }), true)
  assert.equal(sourceCaptureEnabled('claude-code', { AGENT_LENS_ENABLED_SOURCES: 'none' }), false)
})

test('Codex hook reads the AgentLens user-level source configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-hook-policy-'))
  const path = join(root, 'capture-policy.json')
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      enabledSources: ['claude-code', 'Codex'],
      updatedAt: new Date().toISOString(),
    }), 'utf8')
    const env = { AGENT_LENS_CAPTURE_POLICY_PATH: path }
    assert.deepEqual(enabledSources(env), ['claude-code', 'codex'])
    assert.equal(sourceCaptureEnabled('codex', env), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex hook does not write inbox while source is disabled', async () => {
  const inbox = await mkdtemp(join(tmpdir(), 'agent-lens-hook-codex-disabled-'))
  try {
    const result = await persistCodexHookEvent({ hook_event_name: 'PreToolUse' }, {
      inboxDir: inbox,
      env: { AGENT_LENS_ENABLED_SOURCES: 'claude-code' },
    })
    assert.equal(result, null)
    assert.deepEqual(await readdir(inbox), [])
  } finally {
    await rm(inbox, { recursive: true, force: true })
  }
})

test('Codex hook persists one sanitized durable inbox event when source is enabled', async () => {
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
    }, {
      inboxDir: inbox,
      env: { AGENT_LENS_ENABLED_SOURCES: 'codex' },
    })

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
