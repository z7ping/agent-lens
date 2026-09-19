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
  assert.match(snapshot, /refreshExternallyUpdatedSession/)
  assert.doesNotMatch(state, /latestPiSessionEntryId|refreshExternallyUpdatedSession/)
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
