import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  getHookStatus,
  installHooks,
  uninstallHooks,
} from './index'

function handlerCount(config: any, marker: string): number {
  let count = 0
  for (const groups of Object.values(config.hooks ?? {})) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as any[]) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command === 'string' && hook.command.includes(marker)) count += 1
      }
    }
  }
  return count
}

test('Claude hook management is idempotent and preserves third-party handlers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-lens-hook-claude-'))
  const settings = join(home, '.claude', 'settings.json')
  await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.claude'), { recursive: true }))
  await writeFile(settings, JSON.stringify({
    theme: 'dark',
    hooks: {
      PreToolUse: [{ hooks: [
        { type: 'command', command: 'third-party-hook' },
        { type: 'command', command: 'agent-lens-hook-claude --old' },
      ] }],
    },
  }))

  await installHooks('claude', { homeDir: home })
  await installHooks('claude', { homeDir: home })
  const installed = JSON.parse(await readFile(settings, 'utf8'))
  assert.equal(handlerCount(installed, 'agent-lens-hook-claude'), 2)
  assert.equal(handlerCount(installed, 'third-party-hook'), 1)
  assert.equal((await getHookStatus('claude', { homeDir: home })).installed, true)

  await uninstallHooks('claude', { homeDir: home })
  const removed = JSON.parse(await readFile(settings, 'utf8'))
  assert.equal(handlerCount(removed, 'agent-lens-hook-claude'), 0)
  assert.equal(handlerCount(removed, 'third-party-hook'), 1)
  assert.equal(removed.theme, 'dark')
})

test('Codex hook management preserves unrelated hooks and owns only its trust entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-lens-hook-codex-'))
  const codexDir = join(home, '.codex')
  await import('node:fs/promises').then(fs => fs.mkdir(codexDir, { recursive: true }))
  const hooksFile = join(codexDir, 'hooks.json')
  const configFile = join(codexDir, 'config.toml')
  await writeFile(hooksFile, JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'third-party-hook' }] }],
    },
  }))
  await writeFile(configFile, '[features]\nexample = true\n\n[hooks.state."third-party"]\ntrusted_hash = "sha256:keep"\n')

  await installHooks('codex', { homeDir: home })
  await installHooks('codex', { homeDir: home })
  const installed = JSON.parse(await readFile(hooksFile, 'utf8'))
  assert.equal(handlerCount(installed, 'agent-lens-hook-codex'), 11)
  assert.equal(handlerCount(installed, 'third-party-hook'), 1)
  const status = await getHookStatus('codex', { homeDir: home })
  assert.equal(status.installed, true)
  assert.equal(status.trusted, true)

  await uninstallHooks('codex', { homeDir: home })
  const removed = JSON.parse(await readFile(hooksFile, 'utf8'))
  const toml = await readFile(configFile, 'utf8')
  assert.equal(handlerCount(removed, 'agent-lens-hook-codex'), 0)
  assert.equal(handlerCount(removed, 'third-party-hook'), 1)
  assert.match(toml, /\[hooks\.state\."third-party"\]/)
  assert.doesNotMatch(toml, /agent-lens-hook-codex/)
})
