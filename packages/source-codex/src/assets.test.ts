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
import { codexSourceDefinition, detectCodex } from './index'

async function prepareAssetFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-codex-assets-'))
  await mkdir(join(root, 'sessions'), { recursive: true })
  await mkdir(join(root, 'skills', 'review-helper'), { recursive: true })
  await mkdir(join(root, 'plugins', 'cache', 'acme-plugin'), { recursive: true })
  await mkdir(join(root, 'plugins', 'local-plugin'), { recursive: true })

  await writeFile(
    join(root, 'skills', 'review-helper', 'SKILL.md'),
    '# Review helper\n',
    'utf8',
  )
  await writeFile(
    join(root, 'plugins', 'cache', 'acme-plugin', 'plugin.json'),
    JSON.stringify({ id: 'acme.codex', name: 'acme-plugin', version: '1.2.3' }),
    'utf8',
  )
  await writeFile(
    join(root, 'plugins', 'cache', 'acme-plugin', 'SKILL.md'),
    '# Plugin skill\n',
    'utf8',
  )
  await writeFile(
    join(root, 'config.toml'),
    '[mcp_servers.playwright]\ncommand = "npx"\n\n[mcp_servers."github"]\ncommand = "gh-mcp"\n',
    'utf8',
  )
  await writeFile(
    join(root, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'agent-lens-hook-codex' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'agent-lens-hook-codex' }] }],
      },
    }),
    'utf8',
  )
  await writeFile(join(root, 'AGENTS.md'), '# Global instructions\n', 'utf8')
  return root
}

test('Codex asset scan materializes stable definitions, bindings, states and evidence', async () => {
  const root = await prepareAssetFixture()
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const capabilities = new DefaultCapabilityService()
    const assets = new DefaultAssetService(storage)
    const evidence = new DefaultEvidenceService(storage)
    const capturePolicy = createTestCapturePolicy(['codex'])
    const runner = new SourceAssetRunner(
      storage,
      identity,
      capabilities,
      assets,
      evidence,
      capturePolicy,
    )
    const host = await identity.resolveHost({
      name: 'codex-asset-host',
      platform: process.platform,
      arch: process.arch,
    })
    const [detected] = await detectCodex({
      host,
      env: { CODEX_HOME: root, PATH: '' },
    })
    assert.ok(detected)

    const first = await runner.scan({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })
    assert.ok(first.assetsDiscovered >= 7)
    assert.ok(first.statesRecorded >= first.assetsDiscovered)

    const definitions = storage.db.prepare(
      'SELECT type, canonical_name AS canonicalName FROM asset_definitions ORDER BY type, canonical_name',
    ).all() as Array<{ type: string; canonicalName: string }>
    const identities = new Set(definitions.map(item => `${item.type}:${item.canonicalName}`))

    assert.equal(identities.has('skill:review-helper'), true)
    assert.equal(identities.has('mcp:playwright'), true)
    assert.equal(identities.has('mcp:github'), true)
    assert.equal(identities.has('plugin:acme-plugin'), true)
    assert.equal(identities.has('hook:codex-hook:PreToolUse'), true)
    assert.equal(identities.has('rule:codex-global-instructions'), true)

    const stateRows = storage.db.prepare(
      'SELECT evidence_refs_json AS evidenceRefs FROM asset_state_observations',
    ).all() as Array<{ evidenceRefs: string }>
    assert.ok(stateRows.length > 0)
    assert.equal(stateRows.every(row => JSON.parse(row.evidenceRefs).length >= 1), true)

    const staticEvidence = storage.db.prepare(
      "SELECT COUNT(*) AS count FROM evidence WHERE capture_method = 'static-scan'",
    ).get() as { count: number }
    assert.ok(staticEvidence.count > 0)

    const beforeReplay = {
      definitions: definitions.length,
      bindings: (storage.db.prepare('SELECT COUNT(*) AS count FROM asset_bindings').get() as { count: number }).count,
      states: stateRows.length,
      evidence: staticEvidence.count,
    }

    await runner.scan({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })

    assert.deepEqual({
      definitions: (storage.db.prepare('SELECT COUNT(*) AS count FROM asset_definitions').get() as { count: number }).count,
      bindings: (storage.db.prepare('SELECT COUNT(*) AS count FROM asset_bindings').get() as { count: number }).count,
      states: (storage.db.prepare('SELECT COUNT(*) AS count FROM asset_state_observations').get() as { count: number }).count,
      evidence: (storage.db.prepare("SELECT COUNT(*) AS count FROM evidence WHERE capture_method = 'static-scan'").get() as { count: number }).count,
    }, beforeReplay)
  } finally {
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
