import assert from 'node:assert/strict'
import test from 'node:test'
import type { LogicalSession, SessionRepository, SourceSession, StorageService } from '@agent-lens/core'
import { DefaultIdentityService as LegacyIdentityService } from './index'
import { DefaultIdentityService } from './runtime-profile-services'

function createIdentityStorage() {
  const logical = new Map<string, LogicalSession>()
  const source = new Map<string, SourceSession>()
  const sessions = {
    async getLogicalSession(id: string) { return logical.get(id) ?? null },
    async putLogicalSession(value: LogicalSession) { logical.set(value.id, value) },
    async getSourceSession(id: string) { return source.get(id) ?? null },
    async findSourceSession(sourceId: string, installationId: string, nativeSessionId: string) {
      return [...source.values()].find(value =>
        value.sourceId === sourceId
        && value.installationId === installationId
        && value.nativeSessionId === nativeSessionId,
      ) ?? null
    },
    async putSourceSession(value: SourceSession) { source.set(value.id, value) },
  } as unknown as SessionRepository
  const storage = { repositories: { sessions } } as unknown as StorageService
  return { storage, logical, source }
}

test('no-profile session ids remain identical to the legacy identity service', async () => {
  const legacyState = createIdentityStorage()
  const nextState = createIdentityStorage()
  const legacy = new LegacyIdentityService(legacyState.storage)
  const next = new DefaultIdentityService(nextState.storage)

  const legacyLogical = await legacy.resolveLogicalSession({ installationId: 'install-1', nativeSessionId: 'same-id' })
  const nextLogical = await next.resolveLogicalSession({ installationId: 'install-1', nativeSessionId: 'same-id' })
  const legacySource = await legacy.resolveSourceSession({
    sourceId: 'pi', installationId: 'install-1', nativeSessionId: 'same-id', logicalSessionId: legacyLogical.id,
  })
  const nextSource = await next.resolveSourceSession({
    sourceId: 'pi', installationId: 'install-1', nativeSessionId: 'same-id', logicalSessionId: nextLogical.id,
  })

  assert.equal(nextLogical.id, legacyLogical.id)
  assert.equal(nextSource.id, legacySource.id)
})

test('same nativeSessionId is isolated by RuntimeProfile', async () => {
  const state = createIdentityStorage()
  const identity = new DefaultIdentityService(state.storage)

  const logicalA = await identity.resolveLogicalSession({
    installationId: 'install-1', runtimeProfileId: 'profile-a', nativeSessionId: 'same-id',
  })
  const logicalB = await identity.resolveLogicalSession({
    installationId: 'install-1', runtimeProfileId: 'profile-b', nativeSessionId: 'same-id',
  })
  const sourceA = await identity.resolveSourceSession({
    sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: 'profile-a',
    nativeSessionId: 'same-id', logicalSessionId: logicalA.id,
  })
  const sourceB = await identity.resolveSourceSession({
    sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: 'profile-b',
    nativeSessionId: 'same-id', logicalSessionId: logicalB.id,
  })

  assert.notEqual(logicalA.id, logicalB.id)
  assert.notEqual(sourceA.id, sourceB.id)
  assert.equal(logicalA.runtimeProfileId, 'profile-a')
  assert.equal(logicalB.runtimeProfileId, 'profile-b')
})

test('profile-aware identity reuses an already backfilled legacy session id', async () => {
  const state = createIdentityStorage()
  const legacy = new LegacyIdentityService(state.storage)
  const legacyLogical = await legacy.resolveLogicalSession({ installationId: 'install-1', nativeSessionId: 'same-id' })
  const legacySource = await legacy.resolveSourceSession({
    sourceId: 'dsh', installationId: 'install-1', nativeSessionId: 'same-id', logicalSessionId: legacyLogical.id,
  })
  state.logical.set(legacyLogical.id, { ...legacyLogical, runtimeProfileId: 'profile-a' })
  state.source.set(legacySource.id, { ...legacySource, runtimeProfileId: 'profile-a' })

  const identity = new DefaultIdentityService(state.storage)
  const logical = await identity.resolveLogicalSession({
    installationId: 'install-1', runtimeProfileId: 'profile-a', nativeSessionId: 'same-id',
  })
  const source = await identity.resolveSourceSession({
    sourceId: 'dsh', installationId: 'install-1', runtimeProfileId: 'profile-a',
    nativeSessionId: 'same-id', logicalSessionId: logical.id,
  })

  assert.equal(logical.id, legacyLogical.id)
  assert.equal(source.id, legacySource.id)
})
