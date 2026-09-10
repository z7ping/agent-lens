import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveClaudeLocation,
  resolveCodexLocation,
  resolvePiLocation,
} from './source-environment'

const home = join('agentlens-test', 'home')

test('Source locations use stable defaults', () => {
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

test('Claude location centralizes CLAUDE_CODE_HOME and legacy CLAUDE_HOME priority', () => {
  assert.equal(
    resolveClaudeLocation({ CLAUDE_CODE_HOME: '/primary', CLAUDE_HOME: '/legacy' }, home).configRoot,
    '/primary',
  )
  assert.equal(resolveClaudeLocation({ CLAUDE_HOME: '/legacy' }, home).configRoot, '/legacy')
})

test('Pi location keeps native directory precedence', () => {
  assert.deepEqual(resolvePiLocation({
    PI_HOME: '/pi-home',
    PI_CODING_AGENT_DIR: '/agent-dir',
    PI_CODING_AGENT_SESSION_DIR: '/session-dir',
  }, home), {
    configRoot: '/agent-dir',
    dataRoot: '/session-dir',
    explicit: true,
  })
})

test('Source locations expand home-relative overrides against the supplied home', () => {
  assert.equal(resolveCodexLocation({ CODEX_HOME: '~/.custom-codex' }, home).configRoot, join(home, '.custom-codex'))
  assert.equal(resolveClaudeLocation({ CLAUDE_CODE_HOME: '~/.custom-claude' }, home).configRoot, join(home, '.custom-claude'))
  assert.equal(resolvePiLocation({ PI_CODING_AGENT_SESSION_DIR: '~/pi-sessions' }, home).dataRoot, join(home, 'pi-sessions'))
})
