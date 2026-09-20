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

test('codex semantic profile v1 is a valid AgentLens semantic contract', () => {
  assert.equal(profile.schemaVersion, '1.1')
  assert.equal(profile.source, 'codex')
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


test('Codex profile covers current official Rollout, ResponseItem, TurnItem and Hook inventories', () => {
  const nativeTypes = new Set(profile.mappings.map(item => item.nativeType))
  for (const type of [
    'session_meta', 'inter_agent_communication', 'inter_agent_communication_metadata',
    'compacted', 'turn_context', 'token_usage_record', 'world_state', 'retained_context',
    'security_risk_score', 'realtime_item',
  ]) {
    assert.equal(nativeTypes.has(type), true, `rollout:${type}`)
  }

  for (const type of [
    'message', 'additional_tools', 'agent_message', 'reasoning', 'local_shell_call',
    'function_call', 'tool_search_call', 'function_call_output', 'tool_search_output',
    'custom_tool_call', 'custom_tool_call_output', 'web_search_call', 'image_generation_call',
    'compaction', 'configuration_update', 'compaction_trigger', 'context_compaction', 'other',
  ]) {
    assert.equal(nativeTypes.has(`response_item/${type}`), true, `response:${type}`)
  }

  const itemTypes = profile.mappings
    .filter(item => item.nativeType === 'event_msg/item_completed')
    .map(item => item.when?.['item.type'])
    .filter((value): value is string => typeof value === 'string')
  for (const type of [
    'UserMessage', 'FunctionCallOutput', 'HookPrompt', 'AgentMessage', 'Plan', 'Reasoning',
    'CommandExecution', 'DynamicToolCall', 'CollabAgentToolCall', 'SubAgentActivity',
    'WebSearch', 'ImageView', 'Extension', 'ImageGeneration', 'EnteredReviewMode',
    'ExitedReviewMode', 'FileChange', 'McpToolCall', 'ContextCompaction',
  ]) {
    assert.equal(itemTypes.includes(type), true, `turnItem:${type}`)
  }

  const hooks = (profile.knownButOutOfScope?.runtimeHooks ?? []) as string[]
  for (const event of [
    'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
    'Stop', 'Interrupt',
  ]) {
    assert.equal(hooks.includes(event), true, `hook:${event}`)
    assert.equal(nativeTypes.has(`hook/${event}`), true, `hook-mapping:${event}`)
  }
})
