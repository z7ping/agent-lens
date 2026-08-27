import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertNodeCapabilities,
  capabilitiesForProfile,
  defaultAgentLensDataRoot,
  loadOrCreateNodeIdentity,
  nodeIdentityPath,
  resolveAgentLensDataRoot,
  resolveAgentLensRuntimeProfile,
} from './node-identity'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-lens-node-'))
}

test('Node Identity is created once and stays stable across reloads', () => {
  const root = tempRoot()
  try {
    const first = loadOrCreateNodeIdentity(root, {
      randomId: () => '2f3caad0-7c45-4fe0-97d1-cf4b5302ce77',
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    })
    const second = loadOrCreateNodeIdentity(root, {
      randomId: () => '4f0b358b-5bb9-4ff9-a6d6-3195bba0480d',
    })

    assert.equal(first.nodeId, '2f3caad0-7c45-4fe0-97d1-cf4b5302ce77')
    assert.equal(second.nodeId, first.nodeId)
    assert.equal(second.createdAt, '2026-08-27T00:00:00.000Z')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('corrupt Node Identity fails closed instead of silently generating a new identity', () => {
  const root = tempRoot()
  try {
    writeFileSync(nodeIdentityPath(root), '{"schemaVersion":1,"nodeId":"broken"}\n')
    assert.throws(() => loadOrCreateNodeIdentity(root), /Invalid AgentLens node identity document/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('data root defaults to ~/.agent-lens/1.0 and supports one explicit override', () => {
  assert.equal(defaultAgentLensDataRoot('/home/tester'), join('/home/tester', '.agent-lens', '1.0'))
  assert.equal(resolveAgentLensDataRoot({}, '/home/tester'), join('/home/tester', '.agent-lens', '1.0'))
  assert.equal(
    resolveAgentLensDataRoot({ AGENT_LENS_DATA_ROOT: '/srv/agent-lens' }, '/home/tester'),
    '/srv/agent-lens',
  )
})

test('Alpha runtime profiles map to the four frozen capability combinations', () => {
  assert.deepEqual(capabilitiesForProfile('standalone'), {
    localCapture: true,
    replicationUpstream: false,
    hubAccept: false,
  })
  assert.deepEqual(capabilitiesForProfile('node'), {
    localCapture: true,
    replicationUpstream: true,
    hubAccept: false,
  })
  assert.deepEqual(capabilitiesForProfile('hub'), {
    localCapture: true,
    replicationUpstream: false,
    hubAccept: true,
  })
  assert.deepEqual(capabilitiesForProfile('pure-hub'), {
    localCapture: false,
    replicationUpstream: false,
    hubAccept: true,
  })
})

test('invalid Alpha capability combinations are rejected', () => {
  assert.throws(() => assertNodeCapabilities({
    localCapture: false,
    replicationUpstream: false,
    hubAccept: false,
  }), /disable all capabilities/)

  assert.throws(() => assertNodeCapabilities({
    localCapture: true,
    replicationUpstream: true,
    hubAccept: true,
  }), /replicationUpstream \+ hubAccept/)

  assert.throws(() => assertNodeCapabilities({
    localCapture: false,
    replicationUpstream: true,
    hubAccept: false,
  }), /without localCapture/)
})

test('runtime profile defaults to standalone and rejects unknown values', () => {
  assert.equal(resolveAgentLensRuntimeProfile(undefined), 'standalone')
  assert.equal(resolveAgentLensRuntimeProfile(' PURE-HUB '), 'pure-hub')
  assert.throws(() => resolveAgentLensRuntimeProfile('federated'), /Unknown AGENT_LENS_PROFILE/)
})
