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
  assert.match(readyBlock, /liveApi\.modelControl/)
  assert.match(readyBlock, /liveApi\.thinkingControl/)
  assert.match(readyBlock, /liveApi\.queueState/)
  assert.doesNotMatch(readyBlock, /navigate\(/)
})
