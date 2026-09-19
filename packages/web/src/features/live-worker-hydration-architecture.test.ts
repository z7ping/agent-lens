import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')

test('Live task shell and SSE bootstrap do not wait for Worker-backed Snapshot', () => {
  const reset = page.indexOf("setBootstrapTarget(null)")
  const bootstrap = page.indexOf("setBootstrapTarget({ liveId: current.liveId, runtimeSessionId: current.runtimeSessionId })", reset)
  const state = page.indexOf("const stateRequest = liveApi.state(", reset)
  const snapshot = page.indexOf("void liveApi.snapshot(", reset)

  assert.ok(reset >= 0 && bootstrap > reset)
  assert.ok(state > bootstrap, 'logical state may load after the shell/SSE target is established')
  assert.ok(snapshot > state, 'Snapshot must be supporting transcript work, not the page/SSE gate')
  assert.doesNotMatch(
    page.slice(reset, snapshot),
    /await liveApi\.snapshot|const criticalRequest = liveApi\.snapshot/,
  )
})

test('initialization diagnostics are requested before ready-only controls', () => {
  const state = page.indexOf("const stateRequest = liveApi.state(")
  const disclosure = page.indexOf("stateRequest.then(() => liveApi.runtimeDisclosures(", state)
  const controls = page.indexOf("const [model, thinkingControl, queueState]", state)

  assert.ok(state >= 0 && disclosure > state)
  assert.ok(controls > disclosure, 'runtime initialization diagnostics must not wait for ready-only controls')
})


test('Live task keeps a prominent initialization progress while background hydration runs', () => {
  assert.match(
    page,
    /\(!state \|\| state\.status === 'initializing'\)[\s\S]{0,260}<OperationProgress/,
  )
  assert.match(page, /statusLabel=\{runtimeStatus\}/)
  assert.match(page, /<LiveRuntimeDisclosures/)
})


test('ready event restores transcript and controls in place without renavigation', () => {
  const subscribe = page.indexOf('const unsubscribe = liveApi.subscribe(')
  const ready = page.indexOf("envelope.normalizedEvent.status === 'ready'", subscribe)
  const effectEnd = page.indexOf('return () => {', ready)
  const readyBlock = page.slice(ready, effectEnd)

  assert.match(readyBlock, /void recover\(\)/)
  const recovery = page.slice(page.indexOf("const recoverOnce = async"), page.indexOf("const recover =", page.indexOf("const recoverOnce = async")))
  assert.match(recovery, /setInputHistory\(projectLiveInputHistory\(/)
  assert.match(readyBlock, /liveApi\.modelControl/)
  assert.match(readyBlock, /liveApi\.thinkingControl/)
  assert.match(readyBlock, /liveApi\.queueState/)
  assert.doesNotMatch(readyBlock, /navigate\(/)
})


test('Generic Live reconciler corrects SSE with visible online and active polling', () => {
  assert.match(page, /let reconcileEpoch = 0/)
  assert.match(page, /const reconcileState = async/)
  assert.match(page, /epoch !== reconcileEpoch/)
  assert.match(page, /document\.addEventListener\('visibilitychange', onVisible\)/)
  assert.match(page, /window\.addEventListener\('online', onOnline\)/)
  assert.match(page, /const onVisible = \(\) => \{[\s\S]{0,120}reconcileState\(false\)/)
  assert.match(page, /const onOnline = \(\) => \{ void reconcileState\(false\) \}/)
  assert.match(page, /window\.setInterval\([\s\S]*5_000/)
  assert.match(page, /if \(runtimeActive/)
  assert.match(page, /setConnected\(true\)[\s\S]{0,100}reconcileState\(true\)/)
  assert.match(page, /reconcileEpoch \+= 1/)
  assert.match(page, /window\.clearInterval\(reconcileTimer\)/)
})

test('Generic Live reconciler only escalates to bounded recovery on drift or explicit recovery boundaries', () => {
  const start = page.indexOf('const reconcileState = async')
  const end = page.indexOf('const onVisible', start)
  const block = page.slice(start, end)
  assert.match(block, /liveApi\.state/)
  assert.match(block, /changed \|\| forceRecovery/)
  assert.match(block, /runtime\.status === 'ready' \|\| runtime\.status === 'initializing'/)
  assert.match(block, /runtime\.status === 'ready' && !runtime\.isStreaming \? 'settle' : 'live'/)
  assert.doesNotMatch(block, /loadBoundedRecoverySnapshot/)
})


test('Runtime reconciler preserves SSE compacting activity until compaction ends', () => {
  assert.match(page, /let runtimeCompacting = false/)
  assert.match(page, /status === 'compacting'[\s\S]{0,120}runtimeCompacting = true/)
  assert.match(page, /runtimeActive = runtime\.isStreaming \|\| runtimeCompacting/)
  assert.match(page, /runtimeCompacting\s*\? 'compacting'/)
  assert.match(page, /status === 'ready'[\s\S]{0,120}runtimeCompacting = false/)
  assert.match(page, /normalizedEvent\?\.type === 'completed'[\s\S]{0,120}runtimeCompacting = false/)
})
