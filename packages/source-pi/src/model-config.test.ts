import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceExecutionContext } from '@agent-lens/core'
import { resolvePiModelConfigAssets } from './model-config'

function context(agentDir: string, sessions: string): SourceExecutionContext {
  const checkpoints = new Map<string, unknown>()
  return {
    installation: { configRoot: agentDir, dataRoot: sessions },
    abortSignal: new AbortController().signal,
    checkpoint: {
      async get<T>(key: string) {
        return (checkpoints.get(key) as T | undefined) ?? null
      },
      async set<T>(key: string, value: T) {
        checkpoints.set(key, structuredClone(value))
      },
      async clear(key: string) {
        checkpoints.delete(key)
      },
    },
  } as unknown as SourceExecutionContext
}

test('Pi model config discovery exposes defaults/custom models without persisting secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-models-'))
  const agentDir = join(root, 'agent')
  const sessions = join(root, 'sessions')
  const project = join(root, 'project')
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessions, { recursive: true })
  await mkdir(join(project, '.pi'), { recursive: true })

  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-test',
  }), 'utf8')
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      ollama: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'SECRET_SHOULD_NOT_PERSIST',
        headers: { Authorization: 'ALSO_SECRET' },
        models: [{ id: 'qwen-test:latest', name: 'Qwen Test' }],
      },
      anthropic: {
        modelOverrides: {
          'claude-sonnet-test': { reasoning: true },
        },
      },
    },
  }), 'utf8')
  await writeFile(join(project, '.pi', 'settings.json'), JSON.stringify({
    defaultProvider: 'ollama',
    defaultModel: 'qwen-test:latest',
  }), 'utf8')
  await writeFile(join(sessions, 'project.jsonl'), `${JSON.stringify({
    type: 'session',
    version: 3,
    id: 'model-project',
    timestamp: '2026-09-12T00:00:00.000Z',
    cwd: project,
  })}\n`, 'utf8')

  try {
    const assets = await resolvePiModelConfigAssets(context(agentDir, sessions))
    assert.equal(assets.length, 4)
    assert.ok(assets.every(asset => asset.definition.type === 'model'))

    assert.ok(assets.some(asset =>
      asset.definition.canonicalName === 'anthropic/claude-sonnet-test'
      && asset.binding?.source === 'pi:model:default:user'
      && asset.binding.scope === 'user'
    ))
    assert.ok(assets.some(asset =>
      asset.definition.canonicalName === 'ollama/qwen-test:latest'
      && asset.definition.displayName === 'Qwen Test'
      && asset.binding?.source === 'pi:model:custom:ollama'
    ))
    assert.ok(assets.some(asset =>
      asset.definition.canonicalName === 'anthropic/claude-sonnet-test'
      && asset.binding?.source === 'pi:model:override:anthropic'
    ))
    assert.ok(assets.some(asset =>
      asset.definition.canonicalName === 'ollama/qwen-test:latest'
      && asset.binding?.source?.startsWith('pi:model:default:project:')
      && asset.binding.scope === 'project'
      && asset.binding.scopeRoot === project
    ))

    const persisted = JSON.stringify(assets)
    assert.doesNotMatch(persisted, /SECRET_SHOULD_NOT_PERSIST|ALSO_SECRET|127\.0\.0\.1:11434/)
    for (const asset of assets) {
      assert.equal(asset.states?.find(state => state.state === 'configured')?.value, true)
      assert.equal(asset.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi malformed model configuration fails the asset scan instead of replacing prior facts with empty data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-models-invalid-'))
  const agentDir = join(root, 'agent')
  const sessions = join(root, 'sessions')
  await mkdir(agentDir, { recursive: true })
  await mkdir(sessions, { recursive: true })
  await writeFile(join(agentDir, 'models.json'), '{"providers":', 'utf8')

  try {
    await assert.rejects(
      resolvePiModelConfigAssets(context(agentDir, sessions)),
      SyntaxError,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
