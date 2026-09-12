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
      'SELECT state, value, evidence_refs_json AS evidenceRefs FROM asset_state_observations',
    ).all() as Array<{ state: string; value: string; evidenceRefs: string }>
    assert.ok(stateRows.length > 0)
    assert.equal(
      stateRows
        .filter(row => row.value !== 'unknown')
        .every(row => JSON.parse(row.evidenceRefs).length >= 1),
      true,
    )
    assert.ok(stateRows.some(row => row.state === 'discoverable' && row.value === 'unknown'))
    assert.ok(stateRows.some(row => row.state === 'enabled' && row.value === 'unknown'))

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


test('Codex 指令资产按当前官方项目根与文件优先级映射作用域', async () => {
  const codexHome = await mkdtemp(join(tmpdir(), 'agent-lens-codex-instructions-'))
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-lens-codex-project-'))
  const cwd = join(projectRoot, 'packages', 'web')
  const packageDir = join(projectRoot, 'packages')
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    await mkdir(join(codexHome, 'sessions'), { recursive: true })
    await mkdir(join(projectRoot, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })

    await writeFile(
      join(codexHome, 'config.toml'),
      'project_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n',
      'utf8',
    )
    await writeFile(join(codexHome, 'AGENTS.md'), '# User instructions\n', 'utf8')
    await writeFile(join(projectRoot, 'TEAM_GUIDE.md'), '# Project fallback\n', 'utf8')
    await writeFile(join(packageDir, 'AGENTS.md'), '# Lower priority\n', 'utf8')
    await writeFile(join(packageDir, 'AGENTS.override.md'), '# Package override\n', 'utf8')
    await writeFile(join(cwd, 'AGENTS.override.md'), '   \n', 'utf8')
    await writeFile(join(cwd, 'AGENTS.md'), '# Shadowed by empty override\n', 'utf8')

    const nativeSessionId = '11111111-1111-4111-8111-111111111111'
    await writeFile(
      join(codexHome, 'sessions', `rollout-${nativeSessionId}.jsonl`),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: nativeSessionId,
          cwd,
          timestamp: '2026-09-12T00:00:00.000Z',
        },
      }) + '\n',
      'utf8',
    )

    const identity = new DefaultIdentityService(storage)
    const runner = new SourceAssetRunner(
      storage,
      identity,
      new DefaultCapabilityService(),
      new DefaultAssetService(storage),
      new DefaultEvidenceService(storage),
      createTestCapturePolicy(['codex']),
    )
    const host = await identity.resolveHost({
      name: 'codex-instruction-host',
      platform: process.platform,
      arch: process.arch,
    })
    const [detected] = await detectCodex({
      host,
      env: { CODEX_HOME: codexHome, PATH: '' },
    })
    assert.ok(detected)

    await runner.scan({
      source: codexSourceDefinition,
      host,
      detected,
      abortSignal: new AbortController().signal,
    })

    const rows = storage.db.prepare(`
      SELECT
        d.canonical_name AS canonicalName,
        d.display_name AS displayName,
        b.path AS path,
        b.scope AS scope,
        b.scope_root AS scopeRoot
      FROM asset_bindings b
      JOIN asset_definitions d ON d.id = b.asset_id
      WHERE d.type = 'rule'
      ORDER BY b.path
    `).all() as Array<{
      canonicalName: string
      displayName: string | null
      path: string
      scope: string | null
      scopeRoot: string | null
    }>

    const byPath = new Map(rows.map(row => [row.path, row]))
    assert.equal(byPath.get(join(codexHome, 'AGENTS.md'))?.scope, 'user')
    assert.equal(byPath.get(join(codexHome, 'AGENTS.md'))?.scopeRoot, codexHome)

    const fallback = byPath.get(join(projectRoot, 'TEAM_GUIDE.md'))
    assert.equal(fallback?.scope, 'project')
    assert.equal(fallback?.scopeRoot, projectRoot)

    const override = byPath.get(join(packageDir, 'AGENTS.override.md'))
    assert.equal(override?.scope, 'project')
    assert.equal(override?.scopeRoot, projectRoot)

    const emptyOverridePath = join(cwd, 'AGENTS.override.md')
    assert.equal(byPath.get(emptyOverridePath)?.scope, 'project')
    assert.equal(byPath.get(emptyOverridePath)?.scopeRoot, projectRoot)

    assert.equal(byPath.has(join(packageDir, 'AGENTS.md')), false)
    assert.equal(byPath.has(join(cwd, 'AGENTS.md')), false)

    const discoverableRows = storage.db.prepare(`
      SELECT
        b.path AS path,
        s.value AS value
      FROM asset_bindings b
      JOIN asset_state_observations s ON s.asset_binding_id = b.id
      WHERE s.state = 'discoverable'
    `).all() as Array<{ path: string; value: string }>
    const discoverableByPath = new Map(discoverableRows.map(row => [row.path, row.value]))

    assert.equal(discoverableByPath.get(join(codexHome, 'AGENTS.md')), 'true')
    assert.equal(discoverableByPath.get(join(projectRoot, 'TEAM_GUIDE.md')), 'unknown')
    assert.equal(discoverableByPath.get(join(packageDir, 'AGENTS.override.md')), 'unknown')
    assert.equal(discoverableByPath.get(emptyOverridePath), 'false')
  } finally {
    storage.close()
    await rm(codexHome, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  }
})
