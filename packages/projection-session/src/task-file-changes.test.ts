import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalObservation } from '@agent-lens/core'
import {
  observedTaskFileChanges,
  patchMutationPaths,
  toolMutationIntent,
} from './task-file-changes'

function observation(
  id: string,
  kind: CanonicalObservation['kind'],
  payload: unknown,
): CanonicalObservation {
  return {
    id,
    hostId: 'host',
    installationId: 'installation',
    logicalSessionId: 'session',
    sourceSessionId: 'source-session',
    kind,
    capturedAt: '2026-09-20T00:00:00.000Z',
    payload,
    evidenceRefs: [],
  }
}

test('does not count read or shell tools as modified files', () => {
  assert.equal(toolMutationIntent(observation('read', 'tool.call', {
    nativeToolName: 'read',
    input: { path: 'src/app.ts' },
  })), undefined)
  assert.equal(toolMutationIntent(observation('shell', 'tool.call', {
    nativeToolName: 'bash',
    input: { command: 'sed -i s/a/b/ src/app.ts' },
  })), undefined)
})

test('pairs successful mutating tool calls with their results', () => {
  const values = observedTaskFileChanges([
    observation('call', 'tool.call', {
      nativeToolName: 'write_file',
      callId: 'call-1',
      input: { path: 'src/app.ts' },
    }),
    observation('result', 'tool.result', {
      callId: 'call-1',
      status: 'success',
    }),
  ])
  assert.deepEqual(values.map(item => [item.path, item.operation, item.evidence, item.confidence]), [
    ['src/app.ts', 'write', 'tool', 'medium'],
  ])
})

test('does not report failed mutating tool calls', () => {
  const values = observedTaskFileChanges([
    observation('call', 'tool.call', {
      nativeToolName: 'edit',
      callId: 'call-2',
      input: { path: 'src/app.ts' },
    }),
    observation('result', 'tool.result', {
      callId: 'call-2',
      status: 'error',
    }),
  ])
  assert.deepEqual(values, [])
})

test('extracts multiple files and rename semantics from apply_patch', () => {
  const paths = patchMutationPaths([
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '*** Add File: src/b.ts',
    '*** Delete File: src/c.ts',
    '*** Update File: src/old.ts',
    '*** Move to: src/new.ts',
    '*** End Patch',
  ].join('\n'))

  assert.deepEqual(paths, [
    { path: 'src/a.ts', operation: 'write' },
    { path: 'src/b.ts', operation: 'write' },
    { path: 'src/c.ts', operation: 'delete' },
    { path: 'src/new.ts', oldPath: 'src/old.ts', operation: 'rename' },
  ])
})
