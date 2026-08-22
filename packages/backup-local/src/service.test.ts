import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type {
  Host,
  IdentityService,
  SourceDefinition,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import { LocalBackupService } from './service'

function fixtureServices(configRoot: string, dataRoot: string) {
  const host: Host = {
    id: 'host-test',
    name: 'test',
    platform: process.platform,
    arch: process.arch,
    createdAt: '2026-08-22T00:00:00.000Z',
    lastSeenAt: '2026-08-22T00:00:00.000Z',
  }
  const source: SourceDefinition = {
    manifest: {
      pluginId: '@test/source',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '1',
    },
    async detect() {
      return [{
        sourceId: 'test-source',
        productId: 'test-product',
        configRoot,
        dataRoot,
        confidence: 'exact',
      }]
    },
    async declareCapabilities() { return [] },
    async *discoverAssets() {
      yield {
        definition: { type: 'skill', canonicalName: 'review' },
        binding: { path: join(configRoot, 'skills', 'review'), source: 'test:skills' },
      }
      yield {
        definition: { type: 'mcp', canonicalName: 'demo' },
        binding: { path: join(configRoot, 'settings.json'), source: 'test:settings' },
      }
    },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
  const checkpoints = new Map<string, unknown>()
  const storage = {
    checkpoints: {
      async get<T>(scope: string, key: string) { return (checkpoints.get(`${scope}:${key}`) as T | undefined) ?? null },
      async set<T>(scope: string, key: string, value: T) { checkpoints.set(`${scope}:${key}`, value) },
      async clear(scope: string, key: string) { checkpoints.delete(`${scope}:${key}`) },
    },
  } as unknown as StorageService
  const sources = { list: () => [source] } as unknown as SourceService
  const identity = {
    async resolveHost() { return host },
    async resolveInstallation() {
      return {
        id: 'installation-test',
        hostId: host.id,
        productId: 'test-product',
        configRoot,
        dataRoot,
        firstSeenAt: '2026-08-22T00:00:00.000Z',
        lastSeenAt: '2026-08-22T00:00:00.000Z',
      }
    },
  } as unknown as IdentityService
  return { storage, sources, identity }
}

test('creates, verifies, exports and imports a raw local snapshot while excluding secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-backup-'))
  const configRoot = join(root, 'agent')
  const dataRoot = join(configRoot, 'sessions')
  const skillRoot = join(configRoot, 'skills', 'review')
  const vaultA = join(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  try {
    await mkdir(skillRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# Review\n', 'utf8')
    await writeFile(join(dataRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')
    await writeFile(join(configRoot, 'settings.json'), '{"apiKey":"sk-ant-secretsecretsecretsecret"}\n', 'utf8')

    const deps = fixtureServices(configRoot, dataRoot)
    const first = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vaultA })
    const manifest = await first.createSnapshot()

    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.files.length, 2)
    assert.ok(manifest.files.some(file => file.kinds.includes('skill')))
    assert.ok(manifest.files.some(file => file.kinds.includes('session')))
    assert.equal(manifest.excluded.length, 1)
    assert.equal(manifest.excluded[0]?.reason, 'sensitive-content')
    assert.equal(JSON.stringify(manifest).includes('secretsecret'), false)

    const verified = await first.verifySnapshot(manifest.id)
    assert.equal(verified.valid, true)
    assert.equal(verified.checkedFiles, 2)

    const exported = await first.exportSnapshot(manifest.id)
    const second = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vaultB })
    const imported = await second.importSnapshot(exported)
    assert.equal(imported.manifestSha256, manifest.manifestSha256)
    assert.equal((await second.verifySnapshot(imported.id)).valid, true)

    await writeFile(join(skillRoot, 'SKILL.md'), '# Review changed\n', 'utf8')
    const preview = await second.previewRestore(imported.id)
    const skill = preview.items.find(item => item.kinds.includes('skill'))
    assert.equal(skill?.status, 'modified')
    assert.equal(preview.blocked, 0)

    const stored = await readFile(join(vaultB, 'snapshots', imported.id, 'manifest.json'), 'utf8')
    assert.equal(stored.includes('secretsecret'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
