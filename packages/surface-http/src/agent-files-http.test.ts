import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceService } from '@agent-lens/core'
import { DefaultIdentityService } from '@agent-lens/core-services'
import type {
  AgentManagedDirectoryResponseDto,
  AgentManagedTextPreviewResponseDto,
} from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

const sources = {
  list: () => [
    {
      manifest: {
        pluginId: '@agent-lens/source-codex',
        pluginVersion: '1.0.0-alpha.5',
        apiVersion: '1.0',
        pluginType: 'source',
        displayName: 'Codex Source',
        sourceId: 'codex',
        productId: 'codex',
        parserVersion: '1',
      },
    },
    {
      manifest: {
        pluginId: '@agent-lens/source-claude',
        pluginVersion: '1.0.0-alpha.5',
        apiVersion: '1.0',
        pluginType: 'source',
        displayName: 'Claude Code Source',
        sourceId: 'claude-code',
        productId: 'claude-code',
        parserVersion: '1',
      },
    },
  ],
} as unknown as SourceService

test('agent managed file HTTP surface only exposes declared config/data roots read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-agent-files-http-'))
  const configRoot = join(root, 'config')
  const dataRoot = join(root, 'data')
  await mkdir(join(configRoot, 'skills'), { recursive: true })
  await mkdir(dataRoot, { recursive: true })
  await writeFile(join(configRoot, 'AGENTS.md'), '# project instructions\n', 'utf8')
  await writeFile(join(configRoot, '.env'), 'TOKEN=secret\n', 'utf8')
  await writeFile(join(configRoot, 'skills', 'SKILL.md'), '# skill\n', 'utf8')
  await writeFile(join(dataRoot, 'session.jsonl'), '{"type":"session"}\n', 'utf8')

  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const identity = new DefaultIdentityService(storage)
  const host = await identity.resolveHost({ name: 'agent-files-http-host' })
  const installation = await identity.resolveInstallation({
    hostId: host.id,
    productId: 'codex',
    configRoot,
    dataRoot,
  })
  const surface = await startHttpSurface(storage, { port: 0, sources })
  const base = `http://${surface.host}:${surface.port}`
  const query = (rootName: 'config' | 'data', path = '') => {
    const params = new URLSearchParams({
      installationId: installation.id,
      root: rootName,
      ...(path ? { path } : {}),
    })
    return params.toString()
  }

  try {
    const listingResponse = await fetch(`${base}/api/v1/agents/codex/files?${query('config')}`)
    assert.equal(listingResponse.status, 200)
    const listing = await listingResponse.json() as AgentManagedDirectoryResponseDto
    assert.equal(listing.sourceId, 'codex')
    assert.equal(listing.installationId, installation.id)
    assert.equal(listing.root, 'config')
    assert.equal(listing.rootPath, configRoot)
    assert.deepEqual(listing.entries.filter(entry => entry.kind === 'directory').map(entry => entry.name), ['skills'])
    assert.deepEqual(
      listing.entries.filter(entry => entry.kind === 'file').map(entry => entry.name).sort(),
      ['.env', 'AGENTS.md'].sort(),
    )
    assert.equal(listing.entries.some(entry => entry.relativePath === 'skills/SKILL.md'), false)

    const previewResponse = await fetch(`${base}/api/v1/agents/codex/file?${query('config', 'AGENTS.md')}`)
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json() as AgentManagedTextPreviewResponseDto
    assert.equal(preview.content, '# project instructions\n')
    assert.equal(preview.relativePath, 'AGENTS.md')

    const nestedResponse = await fetch(`${base}/api/v1/agents/codex/files?${query('config', 'skills')}`)
    assert.equal(nestedResponse.status, 200)
    const nested = await nestedResponse.json() as AgentManagedDirectoryResponseDto
    assert.deepEqual(nested.entries.map(entry => entry.relativePath), ['skills/SKILL.md'])

    const traversalResponse = await fetch(`${base}/api/v1/agents/codex/file?${query('config', '../outside.txt')}`)
    assert.equal(traversalResponse.status, 400)

    const sensitiveResponse = await fetch(`${base}/api/v1/agents/codex/file?${query('config', '.env')}`)
    assert.equal(sensitiveResponse.status, 403)

    const sessionResponse = await fetch(`${base}/api/v1/agents/codex/file?${query('data', 'session.jsonl')}`)
    assert.equal(sessionResponse.status, 415)

    const wrongSourceResponse = await fetch(`${base}/api/v1/agents/claude-code/files?${query('config')}`)
    assert.equal(wrongSourceResponse.status, 404)

    const wrongInstallation = new URLSearchParams({
      installationId: 'installation:missing',
      root: 'config',
    })
    const missingInstallationResponse = await fetch(
      `${base}/api/v1/agents/codex/files?${wrongInstallation.toString()}`,
    )
    assert.equal(missingInstallationResponse.status, 404)

    const writeResponse = await fetch(
      `${base}/api/v1/agents/codex/file?${query('config', 'AGENTS.md')}`,
      { method: 'POST' },
    )
    assert.equal(writeResponse.status, 405)
  } finally {
    await surface.dispose()
    storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
