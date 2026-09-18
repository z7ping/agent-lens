import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('startup session fast path precedes deferred projection repair and maintenance delay', () => {
  const dirty = main.indexOf('const sessionSummaryRunState = await beginSessionSummaryProjectionRun')
  const prepare = main.indexOf("startupSessionDiagnostics.markFirst('source.prepare.started')")
  const capture = main.indexOf("startupSessionDiagnostics.markFirst('source.capture.started')")
  const latest = main.indexOf("startupSessionDiagnostics.markFirst('history.latest.started')")
  const latestFlush = main.indexOf('await app.context.projections.flush(SESSION_SUMMARY_PROJECTION_ID)', latest)
  const deferredDelay = main.indexOf('await abortableDelay(INITIAL_BACKGROUND_SYNC_DELAY_MS', latest)
  const fullRepair = main.indexOf("session summary projection cooperative rebuild started", deferredDelay)

  for (const position of [dirty, prepare, capture, latest, latestFlush, deferredDelay, fullRepair]) {
    assert.notEqual(position, -1)
  }
  assert.ok(dirty < prepare)
  assert.ok(prepare < capture)
  assert.ok(capture < latest)
  assert.ok(latest < latestFlush)
  assert.ok(latestFlush < deferredDelay)
  assert.ok(deferredDelay < fullRepair)
})
