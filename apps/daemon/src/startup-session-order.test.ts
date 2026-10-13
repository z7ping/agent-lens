import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('startup session fast path precedes deferred projection repair and maintenance delay', () => {
  const dirty = main.indexOf('const sessionSummaryRunState = await beginSessionSummaryProjectionRun')
  const prepare = main.indexOf("startupSessionDiagnostics.markFirst('source.prepare.started')")
  const captureTask = main.indexOf('const captureTask = abortableDelay(500, runtimeController.signal)')
  const capture = main.indexOf("startupSessionDiagnostics.markFirst('source.capture.started')")
  const latest = main.indexOf("startupSessionDiagnostics.markFirst('history.latest.started')")
  const latestFlush = main.indexOf('await app.context.projections.flush(SESSION_SUMMARY_PROJECTION_ID)', latest)
  const catchup = main.indexOf('await syncRegisteredSourceHistory(', latestFlush)
  const deferredDelay = main.indexOf('await abortableDelay(INITIAL_BACKGROUND_SYNC_DELAY_MS', latest)
  const fullRepair = main.indexOf("session summary projection cooperative rebuild started", deferredDelay)
  const startupJoin = main.indexOf('await Promise.all(startupTasks)', latest)

  for (const position of [dirty, prepare, captureTask, capture, latest, latestFlush, catchup, startupJoin, deferredDelay, fullRepair]) {
    assert.notEqual(position, -1)
  }
  assert.ok(dirty < prepare)
  assert.ok(dirty < captureTask)
  assert.ok(captureTask < latest)
  assert.ok(captureTask < capture)
  assert.ok(latest < latestFlush)
  assert.ok(latestFlush < catchup)
  assert.ok(catchup < startupJoin)
  assert.ok(latestFlush < startupJoin)
  assert.ok(prepare < startupJoin)
  assert.ok(startupJoin < deferredDelay)
  assert.ok(deferredDelay < fullRepair)
})
