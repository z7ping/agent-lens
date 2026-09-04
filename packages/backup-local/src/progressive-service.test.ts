import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Host, IdentityService, SourceDefinition, SourceService, StorageService } from '@agent-lens/core'
import { LocalBackupService } from './service'

function source(sourceId: string, dataRoot: string, calls: Record<string, number>): SourceDefinition {
  return {
    manifest: {
      pluginId: `@test/${sourceId}`,
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: sourceId === 'pi' ? 'Pi' : 'Codex',
      sourceId,
      productId: sourceId,
      parserVersion: '1',
    },
    async detect() {
      calls[sourceId] = (calls[sourceId] ?? 0) + 1
      return [{ sourceId, productId: sourceId, dataRoot, confidence: 'exact' }]
    },
    async declareCapabilities() { return [] },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
}

test('局部刷新只扫描指定智能体，并按配置顺序合并到同一 inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-backup-progressive-'))
  const piRoot = join(root, 'pi')
  const codexRoot = join(root, 'codex')
  const vaultPath = join(root, 'vault')
  try {
    await mkdir(piRoot, { recursive: true })
    await mkdir(codexRoot, { recursive: true })
    await writeFile(join(piRoot, 'one.jsonl'), '{"source":"pi"}\n', 'utf8')
    await writeFile(join(codexRoot, 'one.jsonl'), '{"source":"codex"}\n', 'utf8')
    await writeFile(join(codexRoot, 'two.jsonl'), '{"source":"codex"}\n', 'utf8')

    const calls: Record<string, number> = {}
    const definitions = [source('codex', codexRoot, calls), source('pi', piRoot, calls)]
    const sources = { list: () => definitions } as unknown as SourceService
    const host: Host = {
      id: 'host-test', name: 'test', platform: process.platform, arch: process.arch,
      createdAt: '2026-08-31T00:00:00.000Z', lastSeenAt: '2026-08-31T00:00:00.000Z',
    }
    const identity = {
      async resolveHost() { return host },
      async resolveInstallation(input: { productId: string; dataRoot?: string }) {
        return {
          id: `installation-${input.productId}`,
          hostId: host.id,
          productId: input.productId,
          ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
          firstSeenAt: '2026-08-31T00:00:00.000Z',
          lastSeenAt: '2026-08-31T00:00:00.000Z',
        }
      },
    } as unknown as IdentityService
    const storage = { checkpoints: {} } as unknown as StorageService
    const service = new LocalBackupService(storage, sources, identity, {
      vaultPath,
      sourceOrder: ['pi', 'codex'],
    })

    const pi = await service.refreshIndex({ sourceIds: ['pi'] })
    assert.deepEqual(pi.sources.map(item => item.sourceId), ['pi'])
    assert.equal(pi.sources[0]?.fileCount, 1)
    assert.deepEqual(calls, { pi: 1 })

    const afterPi = await service.peekOverview()
    assert.deepEqual(afterPi?.sources.map(item => item.sourceId), ['pi'])

    const codex = await service.refreshIndex({ sourceIds: ['codex'] })
    assert.deepEqual(codex.sources.map(item => item.sourceId), ['codex'])
    assert.equal(codex.sources[0]?.fileCount, 2)
    assert.deepEqual(calls, { pi: 1, codex: 1 })

    const complete = await service.peekOverview()
    assert.deepEqual(complete?.sources.map(item => item.sourceId), ['pi', 'codex'])
    assert.deepEqual(complete?.sources.map(item => item.fileCount), [1, 2])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
