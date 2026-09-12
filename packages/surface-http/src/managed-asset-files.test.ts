import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInstallation, StorageService } from '@agent-lens/core'
import {
  readManagedAssetDirectory,
  readManagedAssetFile,
} from './managed-asset-files'

function storageFor(installation: AgentInstallation): StorageService {
  return {
    repositories: {
      installations: {
        async get(id: string) {
          return id === installation.id ? installation : null
        },
      },
    },
  } as unknown as StorageService
}

async function withInstallation(
  run: (input: { installation: AgentInstallation; storage: StorageService; configRoot: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-assets-'))
  const configRoot = join(root, 'config')
  await mkdir(configRoot, { recursive: true })
  const installation: AgentInstallation = {
    id: 'install-pi',
    hostId: 'host-1',
    productId: 'pi',
    configRoot,
    firstSeenAt: '2026-09-12T00:00:00.000Z',
    lastSeenAt: '2026-09-12T00:00:00.000Z',
  }

  try {
    await run({ installation, storage: storageFor(installation), configRoot })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('受管资产适配器保留 Integration 与 Installation 归属并映射目录 DTO', async () => {
  await withInstallation(async ({ installation, storage, configRoot }) => {
    await mkdir(join(configRoot, 'skills'), { recursive: true })
    await writeFile(join(configRoot, 'AGENTS.md'), '# instructions\n', 'utf8')
    await writeFile(join(configRoot, '.env'), 'TOKEN=secret\n', 'utf8')
    await writeFile(join(configRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')

    const response = await readManagedAssetDirectory(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
    })
    const byName = new Map(response.entries.map(entry => [entry.name, entry]))

    assert.equal(response.productId, 'pi')
    assert.equal(response.installationId, installation.id)
    assert.equal(response.rootPath, configRoot)
    assert.equal(byName.get('skills')?.kind, 'directory')
    assert.equal(byName.get('AGENTS.md')?.previewable, true)
    assert.equal(byName.get('.env')?.sensitive, true)
    assert.equal(byName.get('.env')?.previewable, false)
    assert.equal(byName.get('session.jsonl')?.previewable, false)
  })
})

test('受管资产预览复用 shared managed-files 的安全边界', async () => {
  await withInstallation(async ({ installation, storage, configRoot }) => {
    await writeFile(join(configRoot, 'AGENTS.md'), '# instructions\n', 'utf8')
    await writeFile(join(configRoot, '.env.local'), 'SECRET=x\n', 'utf8')

    const preview = await readManagedAssetFile(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
      relativePath: 'AGENTS.md',
    })
    assert.equal(preview.content, '# instructions\n')

    await assert.rejects(
      readManagedAssetFile(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'config',
        relativePath: '.env.local',
      }),
      /protected by its file name/,
    )
    await assert.rejects(
      readManagedAssetDirectory(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'config',
        relativePath: '../outside',
      }),
      /cannot escape/,
    )
  })
})

test('受管资产适配器拒绝跨 Integration 使用 Installation', async () => {
  await withInstallation(async ({ installation, storage }) => {
    await assert.rejects(
      readManagedAssetDirectory(storage, {
        productId: 'codex',
        installationId: installation.id,
        root: 'config',
      }),
      /installation not found for integration/,
    )
  })
})
