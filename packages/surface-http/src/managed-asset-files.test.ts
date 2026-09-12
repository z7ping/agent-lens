import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentInstallation, StorageService } from '@agent-lens/core'
import {
  managedAssetFileInternals,
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

test('受管资产目录只暴露根内文件并标记预览边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-assets-'))
  const configRoot = join(root, 'config')
  await mkdir(join(configRoot, 'skills'), { recursive: true })
  await writeFile(join(configRoot, 'AGENTS.md'), '# instructions\n', 'utf8')
  await writeFile(join(configRoot, 'author.md'), '# not sensitive\n', 'utf8')
  await writeFile(join(configRoot, '.env'), 'TOKEN=secret\n', 'utf8')
  await writeFile(join(configRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')

  const installation: AgentInstallation = {
    id: 'install-pi',
    hostId: 'host-1',
    productId: 'pi',
    configRoot,
    firstSeenAt: '2026-09-12T00:00:00.000Z',
    lastSeenAt: '2026-09-12T00:00:00.000Z',
  }

  try {
    const response = await readManagedAssetDirectory(storageFor(installation), {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
    })
    const byName = new Map(response.entries.map(entry => [entry.name, entry]))

    assert.equal(byName.get('skills')?.kind, 'directory')
    assert.equal(byName.get('AGENTS.md')?.previewable, true)
    assert.equal(byName.get('author.md')?.sensitive, undefined)
    assert.equal(byName.get('author.md')?.previewable, true)
    assert.equal(byName.get('.env')?.sensitive, true)
    assert.equal(byName.get('.env')?.previewable, false)
    assert.equal(byName.get('session.jsonl')?.previewable, false)

    const preview = await readManagedAssetFile(storageFor(installation), {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
      relativePath: 'AGENTS.md',
    })
    assert.equal(preview.content, '# instructions\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('受管资产文件拒绝 traversal、敏感文件与错误 Integration 归属', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-assets-boundary-'))
  const configRoot = join(root, 'config')
  await mkdir(configRoot, { recursive: true })
  await writeFile(join(configRoot, '.env.local'), 'SECRET=x\n', 'utf8')

  const installation: AgentInstallation = {
    id: 'install-pi',
    hostId: 'host-1',
    productId: 'pi',
    configRoot,
    firstSeenAt: '2026-09-12T00:00:00.000Z',
    lastSeenAt: '2026-09-12T00:00:00.000Z',
  }
  const storage = storageFor(installation)

  try {
    await assert.rejects(
      readManagedAssetDirectory(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'config',
        relativePath: '../outside',
      }),
      /traversal/,
    )
    await assert.rejects(
      readManagedAssetFile(storage, {
        productId: 'pi',
        installationId: installation.id,
        root: 'config',
        relativePath: '.env.local',
      }),
      /sensitive files/,
    )
    await assert.rejects(
      readManagedAssetDirectory(storage, {
        productId: 'codex',
        installationId: installation.id,
        root: 'config',
      }),
      /installation not found/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('受管资产文件拒绝通过 symlink 逃逸根目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-assets-symlink-'))
  const configRoot = join(root, 'config')
  const outsideRoot = join(root, 'outside')
  await mkdir(configRoot, { recursive: true })
  await mkdir(outsideRoot, { recursive: true })
  await writeFile(join(outsideRoot, 'outside.md'), '# outside\n', 'utf8')

  let linked = true
  try {
    await symlink(join(outsideRoot, 'outside.md'), join(configRoot, 'escape.md'))
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
    if (code === 'EPERM' || code === 'EACCES') linked = false
    else throw error
  }

  const installation: AgentInstallation = {
    id: 'install-pi',
    hostId: 'host-1',
    productId: 'pi',
    configRoot,
    firstSeenAt: '2026-09-12T00:00:00.000Z',
    lastSeenAt: '2026-09-12T00:00:00.000Z',
  }

  try {
    if (!linked) return
    const directory = await readManagedAssetDirectory(storageFor(installation), {
      productId: 'pi',
      installationId: installation.id,
      root: 'config',
    })
    const escape = directory.entries.find(entry => entry.name === 'escape.md')
    assert.equal(escape?.symlink, true)
    assert.equal(escape?.accessible, false)
    assert.equal(escape?.previewable, false)

    await assert.rejects(
      readManagedAssetFile(storageFor(installation), {
        productId: 'pi',
        installationId: installation.id,
        root: 'config',
        relativePath: 'escape.md',
      }),
      /outside root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('敏感文件判断不把普通 author 文件误判为 auth 凭据', () => {
  assert.equal(managedAssetFileInternals.isSensitivePath('author.md'), false)
  assert.equal(managedAssetFileInternals.isSensitivePath('auth.json'), true)
  assert.equal(managedAssetFileInternals.isSensitivePath('nested/api-key.txt'), true)
})
