import assert from 'node:assert/strict'
import test from 'node:test'
import { StartupSessionDiagnostics } from './startup-session-diagnostics.js'

test('startup session diagnostics keeps first-only milestones and bounded metadata', () => {
  const diagnostics = new StartupSessionDiagnostics(Date.now() - 25)
  diagnostics.markFirst('runtime.ready')
  diagnostics.markFirst('runtime.ready')
  diagnostics.mark('history.latest.source.completed', { sourceId: 'pi', records: 3 })
  diagnostics.markFirst('review.firstSessionVisible', { visibleCount: 20 })

  const snapshot = diagnostics.snapshot()
  assert.deepEqual(snapshot.marks.map(item => item.stage), [
    'runtime.ready',
    'history.latest.source.completed',
    'review.firstSessionVisible',
  ])
  assert.equal(snapshot.marks[1]?.sourceId, 'pi')
  assert.equal(snapshot.marks[1]?.records, 3)
  assert.equal(snapshot.marks[2]?.visibleCount, 20)
  assert.equal(snapshot.marks.every(item => item.elapsedMs >= 0), true)
})
