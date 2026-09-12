import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  resolveClaudeLocation,
  resolveCodexLocation,
  resolveHermesRoots,
  resolveOpenCodeRoots,
  resolvePiLocation,
  resolveToolDiscoveryRoots,
} from './index'

const home = join('agentlens-test', 'home')

test('official catalog keeps the five built-in integrations in stable product order', () => {
  assert.deepEqual(
    OFFICIAL_INTEGRATION_CATALOG.map(item => item.integrationId),
    ['pi', 'codex', 'claude-code', 'hermes', 'opencode'],
  )
})

test('catalog location resolvers preserve existing source defaults', () => {
  assert.deepEqual(resolveCodexLocation({}, home), {
    configRoot: join(home, '.codex'),
    dataRoot: join(home, '.codex', 'sessions'),
    explicit: false,
  })
  assert.deepEqual(resolveClaudeLocation({}, home), {
    configRoot: join(home, '.claude'),
    dataRoot: join(home, '.claude', 'projects'),
    explicit: false,
  })
  assert.deepEqual(resolvePiLocation({}, home), {
    configRoot: join(home, '.pi', 'agent'),
    dataRoot: join(home, '.pi', 'agent', 'sessions'),
    explicit: false,
  })
})

test('declarative discovery roots respect explicit precedence without resolving relative daemon paths', () => {
  const roots = resolveToolDiscoveryRoots('pi', {
    env: {
      PI_CODING_AGENT_DIR: '/custom/pi-agent',
      PI_CODING_AGENT_SESSION_DIR: 'relative-sessions',
    },
    homeDir: '/home/tester',
    platform: 'linux',
  })
  assert.equal(roots.find(item => item.role === 'config')?.path, '/custom/pi-agent')
  assert.equal(roots.some(item => item.role === 'data'), false)
  assert.equal(roots.some(item => item.path === 'relative-sessions'), false)
})

test('explicit relative product homes do not fall back to stale default discovery roots', () => {
  const codex = resolveToolDiscoveryRoots('codex', {
    env: { CODEX_HOME: 'relative-codex' },
    homeDir: '/home/tester',
    platform: 'linux',
  })
  assert.equal(codex.some(item => item.role === 'config'), false)
  assert.equal(codex.some(item => item.role === 'data'), false)

  const hermes = resolveToolDiscoveryRoots('hermes', {
    env: { HERMES_HOME: 'relative-hermes' },
    homeDir: '/home/tester',
    platform: 'linux',
  })
  assert.equal(hermes.some(item => item.role === 'data'), false)
  assert.equal(hermes.some(item => item.role === 'config' && item.path === '/home/tester/.hermes'), true)
})

test('Hermes and OpenCode keep their legacy non-expanding explicit home semantics', () => {
  assert.deepEqual(
    resolveHermesRoots({ HERMES_HOME: '~/custom-hermes' }, home, 'linux'),
    ['~/custom-hermes'],
  )
  assert.equal(
    resolveOpenCodeRoots({ OPENCODE_HOME: '~/custom-opencode' }, home, 'linux')[0],
    '~/custom-opencode',
  )
})

test('Hermes and OpenCode source roots remain centralized in the catalog package', () => {
  assert.deepEqual(
    resolveHermesRoots({ HERMES_HOME: '/srv/hermes' }, home, 'linux'),
    ['/srv/hermes'],
  )
  assert.deepEqual(
    resolveOpenCodeRoots({ OPENCODE_HOME: '/srv/opencode' }, home, 'linux').slice(0, 2),
    ['/srv/opencode', join(home, '.local', 'share', 'opencode')],
  )
})
