import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const profile = JSON.parse(readFileSync(new URL('./semantic-profile.v1.json', import.meta.url), 'utf8')) as {
  schemaVersion: string
  profileVersion: string
  source: string
  mappings: Array<{
    id: string
    nativeType: string
    when?: Record<string, unknown>
    kind?: string
    kinds?: string[]
    disposition?: string
    coverage: string
  }>
  knownButOutOfScope?: Record<string, unknown>
  fallback: { kind: string; preserveRaw: boolean; semanticSource: string }
}

const allowedKinds = new Set([
  'session.lifecycle',
  'message.user',
  'message.assistant',
  'message.commentary',
  'message.reasoning',
  'model.call',
  'model.changed',
  'thinking.level.changed',
  'tool.call',
  'tool.progress',
  'tool.result',
  'permission.request',
  'permission.response',
  'subagent.spawn',
  'subagent.end',
  'context.compaction',
  'context.summary',
  'context.injected',
  'runtime.startup',
  'artifact.action',
  'usage',
  'unknown',
])

test('pi semantic profile v1 is a valid AgentLens semantic contract', () => {
  assert.equal(profile.schemaVersion, '1.1')
  assert.equal(profile.source, 'pi')
  assert.match(profile.profileVersion, /^\d+\.\d+\.\d+$/)
  assert.ok(profile.mappings.length > 0)

  const ids = profile.mappings.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const mapping of profile.mappings) {
    if (mapping.disposition === 'evidence-only') {
      assert.equal(mapping.kind, undefined, `${mapping.id}: evidence-only must not manufacture Canonical observation kind`)
      assert.equal(mapping.kinds, undefined, `${mapping.id}: evidence-only must not manufacture Canonical observation kinds`)
    } else if (mapping.kinds?.length) {
      for (const kind of mapping.kinds) {
        assert.equal(allowedKinds.has(kind), true, `${mapping.id}: ${kind}`)
      }
    } else {
      assert.equal(typeof mapping.kind, 'string', `${mapping.id}: missing kind`)
      assert.equal(allowedKinds.has(mapping.kind!), true, `${mapping.id}: ${mapping.kind}`)
    }
    assert.equal(['complete', 'partial', 'passthrough'].includes(mapping.coverage), true, mapping.id)
  }

  assert.deepEqual(profile.fallback, {
    kind: 'unknown',
    preserveRaw: true,
    semanticSource: 'unknown',
  })
})


test('Pi profile covers current official persisted entries, message roles and StopReason values', () => {
  const nativeTypes = new Set(profile.mappings.map(item => item.nativeType))
  for (const type of [
    'session', 'message', 'thinking_level_change', 'model_change', 'usage', 'compaction',
    'branch_summary', 'custom', 'custom_message', 'label', 'session_info',
  ]) {
    assert.equal(nativeTypes.has(type), true, type)
  }

  const roleMappings = profile.mappings
    .map(item => item.when?.['message.role'])
    .filter((value): value is string => typeof value === 'string')
  for (const role of [
    'system', 'user', 'assistant', 'toolResult',
    'bashExecution', 'custom', 'branchSummary', 'compactionSummary',
  ]) {
    assert.equal(roleMappings.includes(role), true, role)
  }

  const stopReasons = profile.mappings
    .map(item => item.when?.['message.stopReason'])
    .filter((value): value is string => typeof value === 'string')
  for (const reason of ['pending', 'stop', 'length', 'toolUse', 'error', 'aborted', 'deferred']) {
    assert.equal(stopReasons.includes(reason), true, reason)
  }

  const byReason = new Map(profile.mappings
    .filter(item => typeof item.when?.['message.stopReason'] === 'string')
    .map(item => [item.when?.['message.stopReason'] as string, item]))
  assert.equal(byReason.get('stop')?.kind, 'message.assistant')
  assert.equal(byReason.get('toolUse')?.kind, 'message.assistant')
  for (const reason of ['pending', 'length', 'error', 'aborted', 'deferred']) {
    assert.equal(byReason.get(reason)?.kind, 'session.lifecycle', reason)
  }

  const live = (profile.knownButOutOfScope?.events ?? []) as string[]
  for (const event of [
    'connected', 'agent_start', 'agent_end', 'agent_settled', 'prompt_done', 'prompt_error',
    'extension_error', 'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'queue_update',
    'auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'compaction_start',
    'auto_compaction_end', 'compaction_end', 'extension_ui_request', 'extension_ui_closed',
  ]) {
    assert.equal(live.includes(event), true, event)
  }
})
