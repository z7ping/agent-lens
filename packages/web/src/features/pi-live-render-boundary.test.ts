import assert from 'node:assert/strict'
import test from 'node:test'
import { sameStablePiLiveHistoryRoundProps } from './pi-live-render-boundary'

test('stable history render boundary ignores unrelated Composer parent updates', () => {
  const projection = { model: { id: 'round-1' } }
  const previous = { projection, showAllEvents: true, eager: false, estimate: 220 }
  const next = { ...previous }

  assert.equal(sameStablePiLiveHistoryRoundProps(previous, next), true)
  assert.equal(sameStablePiLiveHistoryRoundProps(previous, { ...next, estimate: 221 }), false)
  assert.equal(sameStablePiLiveHistoryRoundProps(previous, { ...next, projection: { ...projection } }), false)
})
