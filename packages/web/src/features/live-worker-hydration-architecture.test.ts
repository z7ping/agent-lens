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
