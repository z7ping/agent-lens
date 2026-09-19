import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const service = await readFile(new URL('./service.ts', import.meta.url), 'utf8')
const tailProbe = await readFile(new URL('./session-disk-tail.ts', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const from = service.indexOf(start)
  const to = service.indexOf(end, from + start.length)
  assert.ok(from >= 0, `missing section start: ${start}`)
  assert.ok(to > from, `missing section end: ${end}`)
  return service.slice(from, to)
}

test('recovery catalog remains logical and does not eagerly start every persisted Worker', () => {
  const restore = section('private async restorePersistedRuntimes', 'private adoptRuntimeSession')
  assert.doesNotMatch(restore, /this\.initialize\(/)
  assert.match(restore, /runtime\.suspended = true/)
  assert.match(restore, /runtime\.status = 'ready'/)
})

test('external JSONL reconciliation stays on mount or recovery Snapshot reads', () => {
  const snapshot = section('async snapshot(id:', 'async historyIndex(')
  const state = section('async state(id:', 'async runtimeDisclosures(')
  assert.match(snapshot, /mountOrRecoveryRead/)
  assert.match(snapshot, /externallyUpdatedRuntimeState/)
  assert.doesNotMatch(state, /latestPiSessionEntryId|externallyUpdatedRuntimeState/)
})

test('session disk probe is bounded and tolerates partial JSONL lines', () => {
  assert.match(tailProbe, /PI_SESSION_TAIL_PROBE_MAX_BYTES = 64 \* 1024/)
  assert.match(tailProbe, /Math\.min\(info\.size/)
  assert.match(tailProbe, /start > 0/)
  assert.match(tailProbe, /JSON\.parse\(line\)/)
  assert.match(tailProbe, /catch \{/)
})

test('idle Worker suspension requires no subscribers and preserves logical Runtime', () => {
  const scheduler = section('private scheduleIdleCheck', 'private runtimeIsQuiescent')
  const suspend = section('private async suspendIdleRuntime', 'private async restartRuntimeWorker')
  assert.match(scheduler, /runtime\.subscriberCount > 0/)
  assert.match(suspend, /runtime\.suspended = true/)
  assert.match(suspend, /runtime\.status = 'ready'/)
  assert.doesNotMatch(suspend, /this\.runtimes\.delete/)
})


test('foreground reads never start Worker hydration before SSE is attached', () => {
  const state = section('async state(id:', 'async runtimeDisclosures(')
  const snapshot = section('async snapshot(id:', 'async historyIndex(')
  const subscribe = section('subscribe(id:', 'async terminate(')

  assert.doesNotMatch(state, /ensureRuntimeHydrated/)
  assert.doesNotMatch(snapshot, /ensureRuntimeHydrated/)

  const listenerIndex = subscribe.indexOf('runtime.events.subscribe(listener)')
  const hydrationIndex = subscribe.indexOf('this.ensureRuntimeHydrated(runtime)')
  assert.ok(listenerIndex >= 0 && hydrationIndex > listenerIndex, 'SSE listener must attach before hydration starts')
})


test('external disk-ahead detection schedules restart only after bounded Snapshot returns', () => {
  const snapshot = section('async snapshot(id:', 'async historyIndex(')
  const detect = snapshot.indexOf('externallyUpdatedRuntimeState(runtime)')
  const read = snapshot.indexOf('await handle.snapshot')
  const restart = snapshot.indexOf('this.scheduleRuntimeRestart(runtime')

  assert.ok(detect >= 0 && read > detect)
  assert.ok(restart > read, 'Worker refresh must not sit in front of the foreground Snapshot read')
})


test('foreground Runtime state never waits for git workspace discovery', () => {
  const state = section('private async runtimeState(runtime:', 'private decorateReadyState')
  assert.match(state, /runtime\.status !== 'initializing'\) this\.refreshWorkspaceContextBestEffort\(runtime\)/)
  assert.doesNotMatch(state, /await this\.refreshWorkspaceContext/)
})

test('workspace git metadata refresh is single-flight and TTL bounded', () => {
  const refresh = section('private refreshWorkspaceContextBestEffort', 'private advanceInitialization')
  assert.match(refresh, /runtime\.workspaceContextTask/)
  assert.match(refresh, /WORKSPACE_CONTEXT_REFRESH_MS/)
  assert.match(refresh, /resolveWorkspaceContext\(runtime\.input\.cwd\)/)
})


test('Pi initialization does not compete with git workspace discovery', () => {
  const initialize = section('private async initialize(runtime:', 'private workerExited(')
  const ready = initialize.indexOf("runtime.status = 'ready'")
  const refresh = initialize.indexOf('this.refreshWorkspaceContextBestEffort(runtime)')
  assert.ok(ready >= 0 && refresh > ready, 'git metadata refresh must start only after the Pi Runtime is ready')
})
