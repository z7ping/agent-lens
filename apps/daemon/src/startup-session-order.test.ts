import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')

test('startup session fast path precedes deferred projection repair and maintenance delay', () => {
  const dirty = main.indexOf('const sessionSummaryRunState = await beginSessionSummaryProjectionRun')
  const prepare = main.indexOf("startupSessionDiagnostics.markFirst('source.prepare.started')")
  const captureGate = main.indexOf('const nativeFastCaptureGate =')
  const captureReady = main.indexOf('const captureReady = nativeFastCaptureGate')
  const captureTask = main.indexOf('const captureTask = captureReady')
  const capture = main.indexOf("startupSessionDiagnostics.markFirst('source.capture.started')")
  const latest = main.indexOf("startupSessionDiagnostics.markFirst('history.latest.started')")
  const latestFlush = main.indexOf('await app.context.projections.flush(SESSION_SUMMARY_PROJECTION_ID)', latest)
  const catchup = main.indexOf('await syncRegisteredSourceHistory(', latestFlush)
  const deferredDelay = main.indexOf('await abortableDelay(INITIAL_BACKGROUND_SYNC_DELAY_MS', latest)
  const fullRepair = main.indexOf("session summary projection cooperative rebuild started", deferredDelay)
  const startupJoin = main.indexOf('await Promise.all(startupTasks)', latest)

  for (const position of [dirty, prepare, captureGate, captureReady, captureTask, capture, latest, latestFlush, catchup, startupJoin, deferredDelay, fullRepair]) {
    assert.notEqual(position, -1)
  }
  assert.ok(dirty < prepare)
  assert.ok(dirty < captureTask)
  assert.ok(captureGate < captureReady && captureReady < captureTask)
  assert.match(main, /: abortableDelay\(500, runtimeController\.signal\)/)
  assert.match(main, /onNativeCatalogReady: \(\) => releaseCapture\?\.\(\)/)
  assert.match(main, /finally \{[\s\S]*?releaseCapture\?\.\(\)[\s\S]*?await captureTask/)
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

test('certified Native-only source startup gates Runtime Capture without legacy environment switches',()=>{
  // SourceHistoryRunner already defaults certified new sessions to native
  // ownership; daemon startup must not race it with the old 500ms capture timer.
  assert.match(main,/const nativeFastCaptureGate = targets\.length === 1/)
  assert.match(main,/targets\[0\]\?\.source\.nativeSessionCoverageComplete === true/)
  assert.match(main,/Boolean\(targets\[0\]\?\.source\.discoverNativeSessions\)/)
  assert.match(main,/Boolean\(targets\[0\]\?\.source\.rawRecovery\?\.verify\)/)
  assert.match(main,/const nativeFast = targets\.some\(target =>/)
  assert.match(main,/nativeCaptureStartupBatches\(targets, nativeFast\)/)
  assert.match(main,/onNativeCatalogReady: \(\) => releaseCapture\?\.\(\)/)
  assert.doesNotMatch(main,/AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS/)
  assert.doesNotMatch(main,/AGENT_LENS_NATIVE_CATALOG_FAST_SCAN/)
})
