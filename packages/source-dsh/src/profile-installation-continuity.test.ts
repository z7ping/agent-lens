import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceExecutionContext } from '@agent-lens/core'
import { profiledDshSourceInternals } from './index'

test('profile execution overlays RuntimeProfile roots without changing the persisted Installation identity', () => {
  const context: SourceExecutionContext = {
    host: {
      id: 'host-test',
      name: 'test',
      platform: process.platform,
      arch: process.arch,
      createdAt: '2026-09-17T00:00:00.000Z',
      lastSeenAt: '2026-09-17T00:00:00.000Z',
    },
    installation: {
      id: 'installation-dsh-legacy',
      hostId: 'host-test',
      productId: 'dsh',
      firstSeenAt: '2026-09-17T00:00:00.000Z',
      lastSeenAt: '2026-09-17T00:00:00.000Z',
    },
    runtimeProfile: {
      id: 'runtime-profile-writer',
      installationId: 'installation-dsh-legacy',
      nativeProfileId: 'writer',
      name: 'writer',
      configRoot: '/dsh/profiles/writer',
      dataRoot: '/dsh/profiles/writer',
      firstSeenAt: '2026-09-17T00:00:00.000Z',
      lastSeenAt: '2026-09-17T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get() { return null },
      async set() {},
      async clear() {},
    },
  }

  const effective = profiledDshSourceInternals.profileContext(context)
  assert.equal(effective.installation.id, 'installation-dsh-legacy')
  assert.equal(effective.installation.configRoot, '/dsh/profiles/writer')
  assert.equal(effective.installation.dataRoot, '/dsh/profiles/writer')
  assert.equal(context.installation.configRoot, undefined)
  assert.equal(context.installation.dataRoot, undefined)
})
