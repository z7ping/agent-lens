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


test('Pi prompt resources use official frontmatter parsing and first-name precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-prompt-'))
  const first = join(root, 'review.md')
  const duplicateDir = join(root, 'duplicate')
  const duplicate = join(duplicateDir, 'review.md')
  const broken = join(root, 'broken.md')
  await mkdir(duplicateDir, { recursive: true })
  await writeFile(first, '---\ndescription: first\n---\nBody\n', 'utf8')
  await writeFile(duplicate, '---\ndescription: second\n---\nBody\n', 'utf8')
  await writeFile(broken, 'BROKEN', 'utf8')

  const api = {
    parseFrontmatter(text: string) {
      if (text === 'BROKEN') throw new Error('invalid frontmatter')
      return { frontmatter: {}, body: text }
    },
  } as any

  try {
    assert.deepEqual(await piResourceResolverInternals.promptCandidate(api, first), {
      name: 'review',
      valid: true,
    })
    assert.deepEqual(await piResourceResolverInternals.promptCandidate(api, broken), {
      name: 'broken',
      valid: false,
    })
    const selected = await piResourceResolverInternals.selectedPromptPaths(api, [
      { path: first, enabled: true, metadata: { source: 'auto', scope: 'user', origin: 'top-level' } },
      { path: duplicate, enabled: true, metadata: { source: 'auto', scope: 'user', origin: 'top-level' } },
      { path: broken, enabled: true, metadata: { source: 'auto', scope: 'user', origin: 'top-level' } },
    ] as any)
    assert.equal(selected.size, 1)
    assert.ok([...selected][0]?.replaceAll('\\\\', '/').endsWith('/review.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi theme candidates do not claim malformed or nameless JSON as discoverable themes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-theme-'))
  const named = join(root, 'named.json')
  const nameless = join(root, 'nameless.json')
  const broken = join(root, 'broken.json')
  await writeFile(named, JSON.stringify({ name: 'night' }), 'utf8')
  await writeFile(nameless, JSON.stringify({ colors: {} }), 'utf8')
  await writeFile(broken, '{', 'utf8')

  try {
    assert.deepEqual(await piResourceResolverInternals.themeCandidate(named), {
      name: 'night',
      definitelyInvalid: false,
    })
    assert.equal((await piResourceResolverInternals.themeCandidate(nameless)).definitelyInvalid, true)
    assert.equal((await piResourceResolverInternals.themeCandidate(broken)).definitelyInvalid, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi context resources keep AGENTS loading separate from project trust and gate project SYSTEM files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-context-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const globalAgents = join(agentDir, 'AGENTS.md')
  const projectAgents = join(project, 'AGENTS.md')
  const projectSystem = join(project, '.pi', 'SYSTEM.md')
  await mkdir(join(project, '.pi'), { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeFile(globalAgents, '# global\n', 'utf8')
  await writeFile(projectAgents, '# project\n', 'utf8')
  await writeFile(projectSystem, '# system\n', 'utf8')

  const api = {
    loadProjectContextFiles({ cwd }: { cwd: string }) {
      return resolve(cwd) === resolve(agentDir)
        ? [{ path: globalAgents, content: '# global' }]
        : [
            { path: globalAgents, content: '# global' },
            { path: projectAgents, content: '# project' },
          ]
    },
  } as any

  try {
    const global = await piResourceResolverInternals.globalContextAssets(api, agentDir, '2026-09-11T00:00:00.000Z')
    assert.ok(global.some(asset => asset.binding?.path === globalAgents))

    const projectAssets = await piResourceResolverInternals.projectContextAssets(
      api,
      project,
      agentDir,
      'unknown',
      '2026-09-11T00:00:00.000Z',
    )
    const agents = projectAssets.find(asset => asset.binding?.path === projectAgents)
    assert.equal(agents?.states?.find(state => state.state === 'enabled')?.value, true)
    assert.equal(agents?.states?.find(state => state.state === 'discoverable')?.value, true)

    const system = projectAssets.find(asset => asset.binding?.path === projectSystem)
    assert.equal(system?.states?.find(state => state.state === 'enabled')?.value, 'unknown')
    assert.equal(system?.states?.find(state => state.state === 'discoverable')?.value, 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('Pi package resource version comes from the installed package manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-package-version-'))
  const packageRoot = join(root, 'package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@example/pi-resources',
    version: '2.3.4',
  }), 'utf8')

  try {
    const resource = {
      path: join(packageRoot, 'skills', 'reviewer', 'SKILL.md'),
      enabled: true,
      metadata: {
        source: 'npm:@example/pi-resources@^2',
        scope: 'user',
        origin: 'package',
        baseDir: packageRoot,
      },
    } as any
    assert.equal(await piResourceResolverInternals.resourceVersion(resource), '2.3.4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
