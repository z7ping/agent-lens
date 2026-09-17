import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

const CAPTURED_AT = '2026-09-16T00:00:00.000Z'

test('重复提交 unchanged Observation 不再制造身份与 Evidence replication revision', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({
      name: 'devbox',
      platform: 'linux',
      arch: 'x64',
    })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      executable: '/usr/bin/codex',
    })

    const input = {
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.assistant' as const,
        nativeEventId: 'event-1',
        capturedAt: CAPTURED_AT,
        payload: { text: 'done' },
        identityHints: {
          nativeSessionId: 'session-native-1',
          workspacePath: '/workspace/agent-lens',
          nativeActorId: 'main',
          actorRole: 'main-agent' as const,
        },
        dedupHints: {
          nativeEventId: 'event-1',
        },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log' as const,
        derivation: 'observed' as const,
        nativeStableId: 'event-1',
        capturedAt: CAPTURED_AT,
      }],
    }

    const beforeFirst = await storage.replicationCanonicalChanges.highWaterRevision()
    const first = await observations.commit(input)
    const afterFirst = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(first.status, 'created')
    assert.ok(afterFirst > beforeFirst)

    const second = await observations.commit(input)
    const afterSecond = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(second.status, 'unchanged')
    assert.equal(afterSecond, afterFirst)

    const changed = await observations.commit({
      ...input,
      candidate: {
        ...input.candidate,
        identityHints: {
          ...input.candidate.identityHints,
          sessionTitle: 'Renamed session',
        },
      },
    })
    const afterRealChange = await storage.replicationCanonicalChanges.highWaterRevision()
    assert.equal(changed.status, 'unchanged')
    assert.ok(afterRealChange > afterSecond)
  } finally {
    await storage.close()
  }
})


test('6 类独立 Replication Root 的 unchanged UPSERT 不推进 journal / Entity Head', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const now = '2026-09-17T04:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host-root',
      name: 'root-host',
      platform: 'linux',
      arch: 'x64',
      createdAt: now,
      lastSeenAt: now,
    })
    await storage.repositories.installations.putProduct({
      id: 'product-root',
      name: 'Root Product',
    })
    await storage.repositories.installations.put({
      id: 'install-root',
      hostId: 'host-root',
      productId: 'product-root',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    await storage.repositories.sessions.putLogicalSession({
      id: 'logical-a',
      installationId: 'install-root',
    })
    await storage.repositories.sessions.putLogicalSession({
      id: 'logical-b',
      installationId: 'install-root',
    })

    const relationship = {
      id: 'relationship-root',
      fromSessionId: 'logical-a',
      toSessionId: 'logical-b',
      type: 'related' as const,
      evidenceRefs: [],
      confidence: 'high' as const,
    }
    const coverage = {
      id: 'coverage-root',
      subjectType: 'installation',
      subjectId: 'install-root',
      capability: 'assets',
      status: 'partial' as const,
      evidenceRefs: [],
    }
    const definition = {
      id: 'asset-root',
      type: 'skill' as const,
      canonicalName: 'root-skill',
      upstreamIdentity: 'npm:@agent-lens/root-skill',
    }
    const binding = {
      id: 'binding-root',
      assetId: 'asset-root',
      installationId: 'install-root',
      scope: 'user' as const,
      version: '1.0.0',
    }
    const state = {
      id: 'state-root',
      assetBindingId: 'binding-root',
      state: 'installed' as const,
      value: true as const,
      observedAt: now,
      evidenceRefs: [],
    }
    const tool = {
      id: 'tool-root',
      canonicalName: 'root-tool',
      sourceType: 'skill-runtime' as const,
      assetDefinitionId: 'asset-root',
      installationId: 'install-root',
      schemaHash: 'schema-1',
    }

    await storage.repositories.sessions.putRelationship(relationship)
    await storage.repositories.coverage.put(coverage)
    await storage.repositories.assets.putDefinition(definition)
    await storage.repositories.assets.putBinding(binding)
    await storage.repositories.assets.putState(state)
    await storage.repositories.tools.put(tool)

    const entityKeys = [
      ['SessionRelationship', relationship.id],
      ['Coverage', coverage.id],
      ['AssetDefinition', definition.id],
      ['AssetBinding', binding.id],
      ['AssetStateObservation', state.id],
      ['ToolDefinition', tool.id],
    ] as const

    const headRevisions = () => new Map(
      entityKeys.map(([entityType, originEntityId]) => {
        const row = storage.db.prepare(`
          SELECT latest_revision AS latestRevision
          FROM replication_entity_heads
          WHERE entity_type = ? AND origin_entity_id = ?
        `).get(entityType, originEntityId) as { latestRevision: number }
        return [`${entityType}:${originEntityId}`, row.latestRevision] as const
      }),
    )

    const beforeNoopHighWater = await storage.replicationCanonicalChanges.highWaterRevision()
    const beforeNoopHeads = headRevisions()

    await storage.repositories.sessions.putRelationship(relationship)
    await storage.repositories.coverage.put(coverage)
    await storage.repositories.assets.putDefinition(definition)
    await storage.repositories.assets.putBinding(binding)
    await storage.repositories.assets.putState(state)
    await storage.repositories.tools.put(tool)

    assert.equal(
      await storage.replicationCanonicalChanges.highWaterRevision(),
      beforeNoopHighWater,
    )
    assert.deepEqual(headRevisions(), beforeNoopHeads)

    await storage.repositories.sessions.putRelationship({
      ...relationship,
      confidence: 'medium',
    })
    await storage.repositories.coverage.put({
      ...coverage,
      status: 'complete',
    })
    await storage.repositories.assets.putDefinition({
      ...definition,
      displayName: 'Root Skill',
    })
    await storage.repositories.assets.putBinding({
      ...binding,
      version: '1.1.0',
    })
    await storage.repositories.assets.putState({
      ...state,
      value: false,
    })
    await storage.repositories.tools.put({
      ...tool,
      schemaHash: 'schema-2',
    })

    const afterChanges = headRevisions()
    assert.ok(
      (await storage.replicationCanonicalChanges.highWaterRevision())
      > beforeNoopHighWater,
    )
    for (const [key, revision] of afterChanges) {
      assert.ok(revision > (beforeNoopHeads.get(key) ?? 0), key)
    }
  } finally {
    await storage.close()
  }
})


test('重复 attach RuntimeProfile 不制造 Session / AssetBinding replication revision', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const now = '2026-09-17T05:00:00.000Z'
    await storage.repositories.hosts.put({
      id: 'host-profile',
      name: 'profile-host',
      platform: 'linux',
      arch: 'x64',
      createdAt: now,
      lastSeenAt: now,
    })
    await storage.repositories.installations.putProduct({
      id: 'product-profile',
      name: 'Profile Product',
    })
    await storage.repositories.installations.put({
      id: 'install-profile',
      hostId: 'host-profile',
      productId: 'product-profile',
      firstSeenAt: now,
      lastSeenAt: now,
    })
    await storage.repositories.sessions.putLogicalSession({
      id: 'logical-profile',
      installationId: 'install-profile',
    })
    await storage.repositories.sessions.putSourceSession({
      id: 'source-profile',
      sourceId: 'test',
      installationId: 'install-profile',
      nativeSessionId: 'native-profile',
      logicalSessionId: 'logical-profile',
    })
    await storage.repositories.assets.putDefinition({
      id: 'asset-profile',
      type: 'skill',
      canonicalName: 'profile-skill',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding-profile',
      assetId: 'asset-profile',
      installationId: 'install-profile',
    })
    const profile = await storage.runtimeProfiles.resolve({
      installationId: 'install-profile',
      nativeProfileId: 'default',
    })

    await storage.runtimeProfiles.attachSession(
      'test',
      'install-profile',
      'native-profile',
      profile.id,
    )
    await storage.runtimeProfiles.attachAssetBinding('binding-profile', profile.id)
    const afterFirstAttach = await storage.replicationCanonicalChanges.highWaterRevision()

    await storage.runtimeProfiles.attachSession(
      'test',
      'install-profile',
      'native-profile',
      profile.id,
    )
    await storage.runtimeProfiles.attachAssetBinding('binding-profile', profile.id)

    assert.equal(
      await storage.replicationCanonicalChanges.highWaterRevision(),
      afterFirstAttach,
    )
  } finally {
    await storage.close()
  }
})
