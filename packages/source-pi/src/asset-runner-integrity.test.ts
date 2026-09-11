import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DefaultAssetService,
  DefaultCapabilityService,
  DefaultEvidenceService,
  DefaultIdentityService,
} from '@agent-lens/core-services'
import { SourceAssetRunner } from '@agent-lens/core-services/source-runner'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { detectPi, piSourceDefinition } from './index'

test('Pi asset scan does not let SourceAssetRunner infer discoverable=true from file presence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-asset-runner-'))
  const agentDir = join(root, 'agent')
  const sessions = join(agentDir, 'sessions')
  const skillDir = join(agentDir, 'skills', 'reviewer')
  await mkdir(skillDir, { recursive: true })
  await mkdir(sessions, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), [
    '---',
    'name: reviewer',
    'description: Review repository changes.',
    '---',
    '',
  ].join('\n'), 'utf8')

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const runner = new SourceAssetRunner(
      storage,
      identity,
      new DefaultCapabilityService(),
      new DefaultAssetService(storage),
      evidence,
      createTestCapturePolicy(['pi']),
    )
    const host = await identity.resolveHost({ name: 'pi-asset-runner-host' })
    const [detected] = await detectPi({
      host,
      env: { PI_CODING_AGENT_DIR: agentDir, PATH: '' },
    })
    assert.ok(detected)

    const result = await runner.scan({
      source: piSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.equal(result.assetsDiscovered, 1)

    const inventory = await storage.assetInventory.listByInstallation(result.installationId)
    assert.equal(inventory.length, 1)
    assert.equal(inventory[0]!.binding.scope, 'user')
    assert.equal(inventory[0]!.binding.scopeRoot, undefined)
    const states = inventory[0]!.states
    assert.equal(states.find(state => state.state === 'installed')?.value, true)
    assert.equal(states.find(state => state.state === 'discoverable')?.value, 'unknown')
    assert.equal(states.find(state => state.state === 'enabled'), undefined)
  } finally {
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
