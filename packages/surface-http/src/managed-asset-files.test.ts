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

function storageFor(
  installation: AgentInstallation,
  bindingPath?: string,
  bindingId = 'binding-preview',
): StorageService {
  return {
    repositories: {
      installations: {
        async get(id: string) {
          return id === installation.id ? installation : null
        },
      },
    },
    assetInventory: {
      async listByInstallation(id: string) {
        if (id !== installation.id || !bindingPath) return []
        return [{
          definition: {
            id: 'asset-preview',
            type: 'context',
            canonicalName: 'preview',
          },
          binding: {
            id: bindingId,
            assetId: 'asset-preview',
            installationId: installation.id,
            path: bindingPath,
            scope: 'project',
            scopeRoot: bindingPath,
          },
          states: [],
        }]
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

    const sensitive = await readManagedAssetFile(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
      relativePath: '.env.local',
    })
    assert.equal(sensitive.previewStatus, 'metadata-only')
    assert.equal(sensitive.blockedReason, 'sensitive')
    assert.equal(sensitive.content, undefined)
    assert.equal(sensitive.kind, 'file')
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

test('资产绑定根只允许读取 Canonical 库中记录的精确文件', async () => {
  await withInstallation(async ({ installation, configRoot }) => {
    const projectRoot = join(configRoot, '..', 'project')
    await mkdir(projectRoot, { recursive: true })
    const assetPath = join(projectRoot, 'AGENTS.md')
    await writeFile(assetPath, '# project instructions\n', 'utf8')
    await writeFile(join(projectRoot, 'secret.txt'), 'should-not-be-reachable\n', 'utf8')
    const storage = storageFor(installation, assetPath)

    const preview = await readManagedAssetFile(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'binding',
      bindingId: 'binding-preview',
      relativePath: '',
    })

    assert.equal(preview.content, '# project instructions\n')
    await assert.rejects(
      readManagedAssetFile(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'binding',
        bindingId: 'binding-preview',
        relativePath: '../secret.txt',
      }),
      /cannot escape|not found|not a file/,
    )
  })
})

test('目录型资产绑定只允许在绑定目录内浏览', async () => {
  await withInstallation(async ({ installation, configRoot }) => {
    const skillRoot = join(configRoot, '..', 'project-skill')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# skill\n', 'utf8')
    const storage = storageFor(installation, skillRoot)

    const listing = await readManagedAssetDirectory(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'binding',
      bindingId: 'binding-preview',
    })
    assert.equal(listing.entries.some(entry => entry.name === 'SKILL.md'), true)

    await assert.rejects(
      readManagedAssetDirectory(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'binding',
        bindingId: 'binding-preview',
        relativePath: '..',
      }),
      /cannot escape/,
    )
  })
})

test('资产绑定预览继承敏感内容脱敏规则', async () => {
  await withInstallation(async ({ installation, configRoot }) => {
    const configPath = join(configRoot, 'models.json')
    await writeFile(configPath, JSON.stringify({
      provider: { apiKey: 'secret-key-value', model: 'demo' },
    }), 'utf8')
    const storage = storageFor(installation, configPath)

    const preview = await readManagedAssetFile(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'binding',
      bindingId: 'binding-preview',
      relativePath: '',
    })
    assert.equal(preview.previewStatus, 'redacted')
    assert.equal(preview.redacted, true)
    assert.match(preview.content ?? '', /\[REDACTED\]/)
    assert.doesNotMatch(preview.content ?? '', /secret-key-value/)
  })
})

test('二进制资产只返回元信息，不伪装成可读文本', async () => {
  await withInstallation(async ({ installation, configRoot }) => {
    const binaryPath = join(configRoot, 'asset.bin')
    await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]))
    const storage = storageFor(installation, binaryPath)

    const preview = await readManagedAssetFile(storage, {
      productId: 'pi',
      installationId: installation.id,
      root: 'binding',
      bindingId: 'binding-preview',
      relativePath: '',
    })
    assert.equal(preview.previewStatus, 'metadata-only')
    assert.equal(preview.blockedReason, 'binary')
    assert.equal(preview.kind, 'file')
    assert.equal(preview.size, 4)
    assert.equal(preview.content, undefined)
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