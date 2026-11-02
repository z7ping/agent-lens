import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  const calls = { detect: 0, discover: 0 }
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
      calls.detect += 1
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
      calls.discover += 1
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
  return { storage, sources, identity, calls }
}

async function listBlobHashes(vault: string): Promise<string[]> {
  const root = join(vault, 'blobs')
  const result: string[] = []
  let prefixes
  try {
    prefixes = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue
    const entries = await readdir(join(root, prefix.name), { withFileTypes: true })
    for (const entry of entries) if (entry.isFile()) result.push(entry.name)
  }
  return result.sort()
}

async function writeLegacySnapshot(vault: string, manifest: Awaited<ReturnType<LocalBackupService['createSnapshot']>>, sourceVault: string) {
  const snapshotRoot = join(vault, 'snapshots', manifest.id)
  await mkdir(join(snapshotRoot, 'files'), { recursive: true })
  for (const file of manifest.files) {
    const bytes = await readFile(join(sourceVault, 'blobs', file.sha256.slice(0, 2), file.sha256))
    const output = join(snapshotRoot, 'files', ...file.archivePath.split('/'))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, bytes)
  }
  await writeFile(join(snapshotRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

test('indexes once, reuses content-addressed blobs, and keeps legacy snapshots compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-backup-'))
  const configRoot = join(root, 'agent')
  const dataRoot = join(configRoot, 'sessions')
  const skillRoot = join(configRoot, 'skills', 'review')
  const vaultA = join(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  const vaultLegacy = join(root, 'vault-legacy')
  try {
    await mkdir(skillRoot, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# Review\n', 'utf8')
    await writeFile(join(dataRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')
    await writeFile(join(configRoot, 'settings.json'), '{"apiKey":"sk-ant-secretsecretsecretsecret"}\n', 'utf8')

    const deps = fixtureServices(configRoot, dataRoot)
    const first = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vaultA })

    const indexed = await first.refreshIndex()
    assert.ok(indexed.index?.generatedAt)
    assert.equal(indexed.sources[0]?.fileCount, 3)
    const discoverAfterIndex = deps.calls.discover

    await first.overview()
    const manifest = await first.createSnapshot()
    assert.equal(deps.calls.discover, discoverAfterIndex, 'overview/create should consume the persisted index instead of rescanning')

    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.files.length, 2)
    assert.ok(manifest.files.some(file => file.kinds.includes('skill')))
    assert.ok(manifest.files.some(file => file.kinds.includes('session')))
    assert.equal(manifest.excluded.length, 1)
    assert.equal(manifest.excluded[0]?.reason, 'sensitive-content')
    assert.equal(JSON.stringify(manifest).includes('secretsecret'), false)

    const initialBlobs = await listBlobHashes(vaultA)
    assert.deepEqual(initialBlobs, manifest.files.map(file => file.sha256).sort())
    assert.equal((await first.verifySnapshot(manifest.id)).valid, true)

    const unchanged = await first.createSnapshot()
    assert.deepEqual(unchanged.files.map(file => file.sha256), manifest.files.map(file => file.sha256))
    assert.deepEqual(await listBlobHashes(vaultA), initialBlobs, 'unchanged snapshots should not duplicate file content')

    await writeLegacySnapshot(vaultLegacy, manifest, vaultA)
    const legacy = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vaultLegacy })
    assert.equal((await legacy.verifySnapshot(manifest.id)).valid, true, 'legacy per-snapshot files remain readable')
    assert.ok((await legacy.exportSnapshot(manifest.id)).byteLength > 0)

    const exported = await first.exportSnapshot(manifest.id)
    const importedService = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vaultB })
    const imported = await importedService.importSnapshot(exported)
    assert.equal(imported.manifestSha256, manifest.manifestSha256)
    assert.equal((await importedService.verifySnapshot(imported.id)).valid, true)
    assert.deepEqual(await listBlobHashes(vaultB), manifest.files.map(file => file.sha256).sort())

    await writeFile(join(skillRoot, 'SKILL.md'), '# Review changed\n', 'utf8')
    await first.refreshIndex()
    const changed = await first.createSnapshot()
    assert.equal((await listBlobHashes(vaultA)).length, initialBlobs.length + 1)
    assert.notEqual(
      changed.files.find(file => file.kinds.includes('skill'))?.sha256,
      manifest.files.find(file => file.kinds.includes('skill'))?.sha256,
    )

    const preview = await importedService.previewRestore(imported.id)
    const skill = preview.items.find(item => item.kinds.includes('skill'))
    assert.equal(skill?.status, 'modified')
    assert.equal(preview.blocked, 0)

    const stored = await readFile(join(vaultB, 'snapshots', imported.id, 'manifest.json'), 'utf8')
    assert.equal(stored.includes('secretsecret'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('empty explicit scopes never back up every source and an in-root vault never indexes itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-backup-vault-'))
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  const vault = join(dataRoot, 'agentlens-backups')
  try {
    await mkdir(dataRoot, { recursive: true })
    await mkdir(configRoot, { recursive: true })
    await writeFile(join(dataRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')
    const deps = fixtureServices(configRoot, dataRoot)
    const service = new LocalBackupService(deps.storage, deps.sources, deps.identity, { vaultPath: vault })
    await assert.rejects(service.createSnapshot({ sourceIds: [], kinds: ['session'] }), /备份范围为空/)
    await assert.rejects(service.createSnapshot({ sourceIds: ['test-source'], kinds: [] }), /备份范围为空/)
    await assert.rejects(service.refreshIndex({ sourceIds: [] }), /备份扫描范围为空/)
    await service.refreshIndex()
    const first = await service.createSnapshot({ sourceIds: ['test-source'], kinds: ['session'] })
    assert.equal(first.files.length, 1)
    assert.equal((await service.verifySnapshot(first.id)).valid, true)
    await service.refreshIndex()
    const second = await service.createSnapshot({ sourceIds: ['test-source'], kinds: ['session'] })
    assert.equal(second.files.length, 1)
    assert.equal(second.files[0]?.sha256, first.files[0]?.sha256)
    const inventory = JSON.parse(await readFile(join(vault, 'inventory-v1.json'), 'utf8')) as {
      files: Array<{ originalPath: string }>
    }
    assert.deepEqual(inventory.files.map(file => file.originalPath), [join(dataRoot, 'session.jsonl')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore preview matches each installation and blocks ambiguous cross-installation targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-backup-restore-targets-'))
  const first = join(root, 'one')
  const second = join(root, 'two')
  const third = join(root, 'three')
  const vault = join(root, 'vault')
  let detectedRoots = [first, second]
  try {
    for (const [dir, label] of [[first, 'first'], [second, 'second'], [third, 'third']]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'session.jsonl'), label + '\n')
    }
    const deps = fixtureServices(join(root, 'config'), first)
    const baseSource = deps.sources.list()[0]!
    const sources = { list: () => [{
      ...baseSource,
      async detect() {
        return detectedRoots.map(dataRoot => ({
          sourceId: 'test-source', productId: 'test-product', dataRoot,
          confidence: 'exact' as const,
        }))
      },
      discoverAssets: undefined,
    }] } as unknown as SourceService
    const identity = {
      resolveHost: deps.identity.resolveHost.bind(deps.identity),
      async resolveInstallation(input: { dataRoot?: string }) {
        const dataRoot = input.dataRoot!
        return {
          id: dataRoot === first ? 'installation-one' : dataRoot === second ? 'installation-two' : 'installation-three',
          hostId: 'host-test', productId: 'test-product', dataRoot,
          firstSeenAt: '2026-08-22T00:00:00.000Z',
          lastSeenAt: '2026-08-22T00:00:00.000Z',
        }
      },
    } as unknown as IdentityService
    const service = new LocalBackupService(deps.storage, sources, identity, { vaultPath: vault })
    await service.refreshIndex()
    const snapshot = await service.createSnapshot({ sourceIds: ['test-source'], kinds: ['session'] })
    assert.equal(snapshot.files.length, 2)
    const firstPreview = await service.previewRestore(snapshot.id)
    assert.equal(firstPreview.unchanged, 2, 'each installation must resolve to its own root')
    assert.equal(firstPreview.modified, 0)
    detectedRoots = [first, third]
    const changed = await service.previewRestore(snapshot.id)
    assert.equal(changed.unchanged, 1)
    assert.equal(changed.blocked, 1)
    assert.match(changed.items.find(item => item.archivePath.includes('installation-two'))?.reason ?? '', /多个安装实例/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
