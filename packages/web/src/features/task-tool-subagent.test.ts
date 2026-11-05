import assert from 'node:assert/strict'
import test from 'node:test'
import { piSubagentResult, piSubagentToolDetails, piSubagentTranscriptMessage } from './task-tool-subagent'

test('official Pi subagent modes read results without inventing a child session', () => {
  for (const mode of ['single', 'parallel', 'chain'] as const) {
    const original = [{ agent: 'scout', status: 'completed', messages: [] },
      { agent: 'worker', status: 'failed', errorMessage: 'exit 1', messages: [] }]
    const parsed = piSubagentToolDetails('subagent', { mode, results: original })
    assert.equal(parsed?.mode, mode)
    assert.equal(parsed?.results, original)
    assert.equal(Object.hasOwn(parsed!, 'childSessionId'), false)
  }
  assert.deepEqual(piSubagentToolDetails('subagent', { mode: 'single', results: [] }),
    { mode: 'single', results: [] })
})

test('only official tool details are recognized, malformed evidence is not guessed', () => {
  const details = { mode: 'parallel', results: [{ agent: 'scout' }] }
  assert.equal(piSubagentToolDetails('bash', details), undefined)
  assert.equal(piSubagentToolDetails('subagent', { results: details.results }), undefined)
  assert.equal(piSubagentToolDetails('subagent', { mode: 'unknown', results: details.results }), undefined)
  assert.equal(piSubagentToolDetails('subagent', { mode: 'single', results: {} }), undefined)
  assert.equal(piSubagentResult({ status: 'completed' }), undefined)
  assert.equal(piSubagentResult({ agent: 'scout', status: 'garbled' })?.status, 'unknown')
})

test('child status, model, usage and original messages are retained without estimated totals', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }]
  const child = piSubagentResult({
    agent: 'reviewer', status: 'failed', task: 'inspect issue', model: 'provider/model',
    step: 2, errorMessage: 'bad token', usage: { input: 18, output: 4, cost: 0.01, turns: 2 },
    messages,
  })
  assert.deepEqual(child, {
    agent: 'reviewer', status: 'failed', task: 'inspect issue', model: 'provider/model',
    step: 2, errorMessage: 'bad token',
    usage: { input: 18, output: 4, cost: 0.01, turns: 2 }, messages,
  })
})

test('subagent messages keep text, thinking, tool call and raw-only unknown content', () => {
  const parsed = piSubagentTranscriptMessage({ role: 'assistant', content: [
    { type: 'text', text: 'reviewing' },
    { type: 'thinking', thinking: 'check imports' },
    { type: 'toolCall', name: 'read', arguments: { path: 'src/main.ts' } },
    { type: 'image', data: 'base64' },
  ] })
  assert.equal(parsed?.role, 'assistant')
  assert.deepEqual(parsed?.parts.map(part => part.kind), ['text', 'thinking', 'toolCall'])
  assert.match(parsed?.parts[2]?.text ?? '', /src\/main\.ts/)
  assert.equal(parsed?.omittedParts, 1, 'unrecognized image content must not silently disappear')
  assert.deepEqual(piSubagentTranscriptMessage({ role: 'user', content: 'Task: inspect' })?.parts,
    [{ kind: 'text', text: 'Task: inspect', truncated: false }])
  assert.equal(piSubagentTranscriptMessage({ role: 'system', content: [] }), undefined)
  assert.equal(piSubagentTranscriptMessage({ role: 'user', content: [
    { type: 'text', text: 'x'.repeat(17_000) },
  ] })?.parts[0]?.truncated, true)
})
