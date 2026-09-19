import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const worker = await readFile(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const host = await readFile(new URL('./worker-host.ts', import.meta.url), 'utf8')
const service = await readFile(new URL('./service.ts', import.meta.url), 'utf8')
const plugin = await readFile(new URL('./plugin.ts', import.meta.url), 'utf8')

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0, `missing section start: ${start}`)
  assert.ok(to > from, `missing section end: ${end}`)
  return source.slice(from, to)
}

test('prewarm builds only a cross-task Runtime Base', () => {
  const base = section(worker, 'async function ensureBaseRuntime', 'function rememberRequestId')
  const prewarm = section(worker, "if (envelope.type === 'prewarm')", "if (!runtimeSessionId) runtimeSessionId")

  assert.match(base, /ModelRuntime\.create/)
  assert.match(base, /allowModelNetwork:\s*false/)
  assert.match(prewarm, /ensureBaseRuntime\(loadedSdk\)/)

  assert.doesNotMatch(prewarm, /createAgentSessionServices/)
  assert.doesNotMatch(prewarm, /createAgentSessionFromServices/)
  assert.doesNotMatch(prewarm, /SessionManager\.(?:create|open)/)
  assert.doesNotMatch(prewarm, /ResourceLoader/)
})

test('task initialization reuses prewarmed ModelRuntime but creates cwd services per Runtime', () => {
  const initialize = section(worker, 'async function initialize(input)', 'function state()')

  assert.match(initialize, /modelRuntime:\s*baseModelRuntime/)
  assert.match(initialize, /SettingsManager\?\.create/)
  assert.match(initialize, /SettingsManager\.create\(options\.cwd, options\.agentDir\)/)
  assert.match(initialize, /createAgentSessionServices/)
  assert.match(initialize, /createAgentSessionFromServices/)
  assert.match(initialize, /sessionManager:\s*options\.sessionManager/)
  assert.match(initialize, /session\.bindExtensions/)
})

test('startup diagnostics split fixed and cwd-bound costs without changing product stages', () => {
  const initialize = section(worker, 'async function initialize(input)', 'function state()')
  for (const name of [
    'sdk_import_ms',
    'model_runtime_create_ms',
    'settings_manager_ms',
    'cwd_services_create_ms',
    'session_manager_ms',
    'agent_session_create_ms',
    'extension_bind_ms',
    'ready_ms',
  ]) {
    assert.match(initialize, new RegExp(name))
  }

  for (const stage of [
    "progress('loading_sdk'",
    "progress('loading_resources'",
    "progress('creating_session'",
    "progress('binding_extensions'",
    "progress('ready'",
  ]) {
    assert.match(initialize, new RegExp(stage.replace(/[()']/g, '\\$&')))
  }
})

test('warm worker mismatch is evicted and replenishment stays single-flight', () => {
  const take = section(host, 'private takeWarmWorker', 'async dispose')
  const preload = section(host, 'private async preloadFor', 'private takeWarmWorker')
  const start = section(host, 'async start(', 'export const piLiveWorkerHostInternals')

  assert.match(take, /sdk_mismatch/)
  assert.match(take, /warm\.child\.kill\(\)/)
  assert.match(preload, /if \(this\.warming\) return this\.warming/)
  assert.match(host, /WARM_CLAIM_GRACE_MS = 250/)
  assert.match(host, /private async claimWarmWorker/)
  assert.match(host, /this\.cancelWarming\(\)/)
  const handshake = start.indexOf('handle.applyHandshake(handshake)')
  const replenish = start.lastIndexOf('void this.preloadFor(input.executable)')
  assert.ok(handshake >= 0 && replenish > handshake, 'warm replenishment must wait until foreground initialization completes')
  assert.match(start, /warmWorkerStatus:\s*claim\.status/)
  assert.match(start, /sdk_discovery_ms/)
  assert.match(start, /worker_spawn_ms/)
})

test('Pi Live plugin still starts prewarm eagerly in the background', () => {
  assert.match(plugin, /void service\.preload\(\)/)
})


test('history Resume/Fork verifies initialize handshake session identity before any follow-up state IPC', () => {
  const initialize = section(service, 'private async initialize(runtime:', 'private workerExited(')
  const handshakeIdentity = initialize.indexOf('handle.initialSessionFile')
  const fallbackState = initialize.indexOf('await handle.state()', handshakeIdentity)
  assert.ok(handshakeIdentity >= 0, 'initialize must consume the session identity captured by the Worker handshake')
  assert.ok(fallbackState > handshakeIdentity, 'state IPC may only remain as a compatibility fallback when handshake identity is unavailable')
})
