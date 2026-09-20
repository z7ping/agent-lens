import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const profile = JSON.parse(readFileSync(new URL('./semantic-profile.v1.json', import.meta.url), 'utf8')) as {
  schemaVersion: string
  profileVersion: string
  source: string
  mappings: Array<{ id: string; kind?: string; disposition?: string; coverage: string }>
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
  assert.equal(profile.schemaVersion, '1.0')
  assert.equal(profile.source, 'pi')
  assert.match(profile.profileVersion, /^\d+\.\d+\.\d+$/)
  assert.ok(profile.mappings.length > 0)

  const ids = profile.mappings.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const mapping of profile.mappings) {
    if (mapping.disposition === 'evidence-only') {
      assert.equal(mapping.kind, undefined, `${mapping.id}: evidence-only must not manufacture Canonical observation kind`)
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
