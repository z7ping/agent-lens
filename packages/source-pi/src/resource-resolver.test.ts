import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { piResourceResolverInternals } from './resource-resolver'

function fakeResourceApi(input: {
  requiresTrust?: boolean
  saved?: boolean | null
  defaultTrust?: 'ask' | 'always' | 'never'
}) {
  const saved = input.saved ?? null
  const defaultTrust = input.defaultTrust ?? 'ask'
  return {
    hasTrustRequiringProjectResources() { return input.requiresTrust ?? true },
    ProjectTrustStore: class {
      get() { return saved }
    },
    SettingsManager: {
      create() {
        return { getDefaultProjectTrust() { return defaultTrust } }
      },
    },
  } as any
}

test('Pi project cwd discovery follows native header semantics and deduplicates workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-cwd-'))
  const sessions = join(root, 'sessions')
  const project = join(root, 'project')
  await mkdir(sessions, { recursive: true })
  await mkdir(project, { recursive: true })

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'pi-project-session',
    timestamp: '2026-09-10T00:00:00.000Z',
    cwd: project,
  })
  await writeFile(join(sessions, 'one.jsonl'), `\n{not-json}\n${header}\n`, 'utf8')
  await writeFile(join(sessions, 'two.jsonl'), `${header}\n`, 'utf8')
  await writeFile(join(sessions, 'relative.jsonl'), `${JSON.stringify({ type: 'session', id: 'relative', cwd: './project' })}\n`, 'utf8')
  await writeFile(join(sessions, 'missing.jsonl'), `${JSON.stringify({ type: 'session', id: 'missing', cwd: join(root, 'missing') })}\n`, 'utf8')

  try {
    const cwd = await piResourceResolverInternals.readSessionCwd(join(sessions, 'one.jsonl'))
    assert.equal(cwd, resolve(project))
    assert.deepEqual(await piResourceResolverInternals.listPiProjectCwds(sessions), [resolve(project)])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi project trust keeps saved/default decisions distinct from unknown interactive trust', async () => {
  const trust = piResourceResolverInternals.builtInProjectTrust
  assert.equal(await trust(fakeResourceApi({ requiresTrust: false }), '/project', '/agent', false), true)
  assert.equal(await trust(fakeResourceApi({ saved: true }), '/project', '/agent', false), true)
  assert.equal(await trust(fakeResourceApi({ saved: false }), '/project', '/agent', false), false)
  assert.equal(await trust(fakeResourceApi({ saved: null, defaultTrust: 'always' }), '/project', '/agent', false), true)
  assert.equal(await trust(fakeResourceApi({ saved: null, defaultTrust: 'never' }), '/project', '/agent', false), false)
  assert.equal(await trust(fakeResourceApi({ saved: null, defaultTrust: 'ask' }), '/project', '/agent', false), 'unknown')
})

test('Pi project trust stays unknown when global extensions may override the built-in decision', async () => {
  const trust = piResourceResolverInternals.builtInProjectTrust
  assert.equal(await trust(fakeResourceApi({ saved: true }), '/project', '/agent', true), 'unknown')
  assert.equal(await trust(fakeResourceApi({ defaultTrust: 'never' }), '/project', '/agent', true), 'unknown')
})

test('Pi resource effective enabled state is gated by project trust', () => {
  const effective = piResourceResolverInternals.effectiveEnabled
  assert.equal(effective(false, true), false)
  assert.equal(effective(true, false), false)
  assert.equal(effective(true, 'unknown'), 'unknown')
  assert.equal(effective(true, true), true)
})

test('Pi project resource bindings keep cwd scope isolated', () => {
  const source = piResourceResolverInternals.resourceSource
  const resource = {
    path: '/shared/.agents/skills/reviewer/SKILL.md',
    enabled: true,
    metadata: { source: 'auto', scope: 'project', origin: 'top-level' },
  } as any
  const first = source(resource, '/workspace/project-a')
  const second = source(resource, '/workspace/project-b')
  assert.notEqual(first, second)
  assert.match(first, /^pi:resource:project:/)
  assert.match(second, /^pi:resource:project:/)
})
