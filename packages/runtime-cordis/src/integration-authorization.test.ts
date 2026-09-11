import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  grantIntegrationCapabilities,
  integrationAuthorizationBootstrap,
  readIntegrationAuthorizationSync,
  writeIntegrationAuthorization,
  type IntegrationAuthorizationConfiguration,
} from './integration-authorization'

test('legacy authorization bootstrap preserves existing configuration and never grants on a fresh install', () => {
  const existing: IntegrationAuthorizationConfiguration = {
    version: 1,
    grants: { pi: ['runtime'] },
    updatedAt: '2026-09-12T00:00:00.000Z',
  }

  assert.equal(
    integrationAuthorizationBootstrap(existing, {
      existingInstallation: true,
      selectedIntegrationIds: ['pi', 'hermes'],
    }),
    null,
  )
  assert.equal(
    integrationAuthorizationBootstrap(null, {
      existingInstallation: false,
      selectedIntegrationIds: ['pi', 'hermes'],
    }),
    null,
  )
})

test('legacy authorization bootstrap only restores historically privileged Pi/Hermes capabilities', () => {
  assert.deepEqual(
    integrationAuthorizationBootstrap(null, {
      existingInstallation: true,
      selectedIntegrationIds: ['pi', 'hermes', 'codex', 'claude-code'],
    }),
    {
      grants: {
        pi: ['runtime', 'live'],
        hermes: ['live'],
      },
    },
  )
})

test('granting a new capability merges with existing grants instead of replacing them', async () => {
  const path = join(tmpdir(), `agent-lens-integration-authorization-${process.pid}.json`)
  try {
    await writeIntegrationAuthorization(path, {
      grants: {
        pi: ['runtime'],
        hermes: ['live'],
      },
    })

    const updated = await grantIntegrationCapabilities(path, 'pi', ['live'])
    assert.deepEqual(updated.grants, {
      pi: ['runtime', 'live'],
      hermes: ['live'],
    })
    assert.deepEqual(readIntegrationAuthorizationSync(path)?.grants, updated.grants)
  } finally {
    await rm(path, { force: true })
  }
})
