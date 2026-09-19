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

test('runtime disclosure summary keeps total elapsed beside resource counts', () => {
  const summary = section(service, 'function runtimeDisclosureSummary', 'function runtimeDisclosureFields')
  assert.match(summary, /\$\{status\.en\} · \$\{fallbackDuration\} ·/)
  assert.match(summary, /\$\{status\.zh\} · \$\{fallbackDuration\} ·/)
})

test('runtime disclosure exposes structured lifecycle stages and resources', () => {
  const lifecycle = section(service, 'function runtimeLifecycle', 'const PI_STARTUP_METRIC_LABELS')
  const disclosures = section(service, 'async runtimeDisclosures(id: string)', 'async executeRuntimeAction')
  for (const stage of ['starting_worker', 'loading_sdk', 'loading_resources', 'creating_session', 'binding_extensions']) {
    assert.match(lifecycle, new RegExp(stage))
  }
  assert.match(lifecycle, /status: failed \? 'failed' as const : active \? 'active' as const : done \? 'done' as const : 'pending' as const/)
  assert.match(lifecycle, /groupId: 'contexts'/)
  assert.match(lifecycle, /groupId: 'skills'/)
  assert.match(lifecycle, /groupId: 'prompts'/)
  assert.match(lifecycle, /groupId: 'extensions'/)
  assert.match(lifecycle, /groupId: 'themes'/)
  assert.match(lifecycle, /state\.status === 'failed' \? state\.error \|\| state\.initializationMessage/)
  assert.match(disclosures, /const lifecycle = runtimeLifecycle\(state\)/)
  assert.match(disclosures, /\.\.\.\(lifecycle \? \{ lifecycle \} : \{\}\)/)
})

test('runtime disclosure main costs use readable labels while raw metrics remain available', () => {
  const labels = section(service, 'const PI_STARTUP_METRIC_LABELS', 'function stageLabel')
  const fields = section(service, 'function runtimeDisclosureFields', 'interface PiUserMessageEntryTarget')
  assert.match(labels, /sdk_discovery_ms:\s*\{ en: 'SDK discovery', zh: 'SDK 发现' \}/)
  assert.match(labels, /cwd_services_create_ms:\s*\{ en: 'Workspace resources', zh: '工作区资源加载' \}/)
  assert.match(fields, /label: contributionText\('Main costs', '主要耗时'\)/)
  assert.match(fields, /kind: 'list' as const/)
  assert.match(fields, /!item\.name\.startsWith\('prewarm_'\)/)
  assert.match(fields, /item\.name !== 'ready_ms'/)
  assert.match(fields, /\.sort\(\(left, right\) => right\.durationMs - left\.durationMs\)/)
  assert.match(fields, /\.slice\(0, 2\)/)
  assert.match(fields, /startupMetricValue\(item\.name, item\.durationMs\)/)
  assert.match(fields, /label: contributionText\('Raw startup metrics', '原始启动指标'\)/)
})

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
  assert.match(initialize, /beginExtensionBinding\(input\)/)
  assert.doesNotMatch(initialize, /await session\.bindExtensions/)
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
  const successTail = start.slice(handshake)
  assert.ok(handshake >= 0)
  assert.doesNotMatch(successTail, /void this\.preloadFor\(input\.executable\)/)
  assert.match(start, /event\.type !== 'runtime_extension_binding'/)
  assert.match(start, /event\.status !== 'ready' && event\.status !== 'failed'/)
  assert.match(start, /void this\.preloadFor\(input\.executable\)/)
  assert.match(start, /warmWorkerStatus:\s*claim\.status/)
  assert.match(start, /sdk_discovery_ms/)
  assert.match(start, /worker_spawn_ms/)
})

test('ready warm worker reuses prewarm SDK discovery before foreground rediscovery', () => {
  const start = section(host, 'async start(', 'export const piLiveWorkerHostInternals')
  const warmClaim = start.indexOf('this.takeWarmWorkerForExecutable(input.executable)')
  const discovery = start.indexOf('discoverInstalledPiSdk(input.executable)')

  assert.ok(warmClaim >= 0, 'foreground start must try the ready Warm Worker first')
  assert.ok(discovery > warmClaim, 'SDK discovery must be a cold/mismatch fallback after the warm fast path')
  assert.match(start, /let sdkDiscoveryMs = 0/)
  assert.match(start, /claim = \{ child: preparedWarm\.child, status: 'hit' \}/)
  assert.match(start, /stage: 'loading_sdk'/)
  assert.match(host, /interface WarmWorker[\s\S]*executable\?: string/)
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


test('Session Core readiness does not await extension binding', () => {
  const initialize = section(worker, 'async function initialize(input)', 'function state()')
  const bind = initialize.indexOf('beginExtensionBinding(input)')
  const ready = initialize.indexOf("progress('ready'", bind)
  assert.ok(bind >= 0 && ready > bind)
  assert.doesNotMatch(initialize.slice(bind, ready), /await extensionBindingPromise|await session\.bindExtensions/)
})

test('extension-sensitive commands wait for background binding while observational reads stay available', () => {
  const command = section(worker, 'async function command(name, value = {})', 'async function dispose()')
  assert.match(command, /if \(needsExtensions\) await waitForExtensionBinding\(\)/)
  for (const name of ['commands', 'navigateTree', 'setModel', 'setThinkingLevel', 'prompt', 'steer', 'followUp']) {
    assert.match(command, new RegExp(`name === '${name}'`))
  }
  const waitIndex = command.indexOf('if (needsExtensions) await waitForExtensionBinding()')
  const stateIndex = command.indexOf("if (name === 'state') return state()")
  assert.ok(waitIndex >= 0 && stateIndex > waitIndex)
  assert.doesNotMatch(command.slice(0, waitIndex), /state.*waitForExtensionBinding/)
})

test('package update IO and warm replenishment wait until extension binding settles', () => {
  const initialize = section(worker, 'async function initialize(input)', 'function state()')
  assert.match(initialize, /extensionBindingPromise\.finally/)
  assert.match(initialize, /startPackageUpdateCheck\(input\.cwd\)/)
  const start = section(host, 'async start(', 'export const piLiveWorkerHostInternals')
  assert.match(start, /runtime_extension_binding/)
  assert.match(start, /event\.status !== 'ready' && event\.status !== 'failed'/)
})


test('Runtime state returns cached resource disclosure instead of rescanning ResourceLoader', () => {
  const state = section(worker, 'function state()', 'function modelSnapshot')
  assert.match(state, /currentStartupResources/)
  assert.doesNotMatch(state, /startupResourceSnapshot/)
  assert.doesNotMatch(state, /getExtensions|getSkills|getPrompts|getThemes|getAgentsFiles/)
})


test('startup audit waits for final extension-discovered resources', () => {
  const persist = section(service, 'private persistStartupAuditBestEffort', 'private scheduleStartupAuditProbe')
  assert.match(persist, /runtime\.extensionBindingStatus === 'binding'/)
  const initialize = section(service, 'private async initialize(runtime:', 'private workerExited(')
  assert.match(initialize, /runtime\.extensionBindingStatus === 'ready' \|\| runtime\.extensionBindingStatus === 'failed'/)
  assert.match(initialize, /this\.scheduleStartupAuditProbe\(runtime, generation\)/)
})


test('Pi session tree is projected from native SessionManager without leaking native entry objects', () => {
  const tree = section(worker, 'function sessionTree()', 'function resolvedRuntimeSessionDir')
  assert.match(tree, /manager\.getTree\(\)/)
  assert.match(tree, /manager\.getBranch\(\)/)
  assert.match(tree, /activePath/)
  assert.match(tree, /branchPointIds/)
  assert.match(tree, /childCount/)
  assert.match(tree, /switchBranch:/)
  assert.match(tree, /fork:/)
  assert.match(tree, /clone: false/)
  assert.doesNotMatch(tree, /entry:\s*entry/)
})

test('session tree stays opt-in and does not replace the existing turn rail', async () => {
  const page = await readFile(new URL('../../../web/src/features/LiveTaskPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /turnRailItems/)
  assert.match(page, /onTurnRailSelect/)
  assert.doesNotMatch(page, /liveApi\.sessionTree\(/)
})
