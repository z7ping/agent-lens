import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const historySource = readFileSync(new URL('./history-interaction.ts', import.meta.url), 'utf8')
const serviceSource = readFileSync(new URL('./service.ts', import.meta.url), 'utf8')
const workerSource = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')

test('Pi 历史继续只按原生 Session 身份定位，不扫描 Observation / Evidence 时间线', () => {
  assert.match(historySource, /listSourceSessionsByLogicalSession/)
  assert.match(historySource, /MAX_RESUME_SOURCE_SESSIONS\s*=\s*8/)
  assert.match(historySource, /sourceId:\s*'pi',[\s\S]{0,80}limit:\s*MAX_RESUME_SOURCE_SESSIONS/)
  assert.match(historySource, /findByNativeId/)
  assert.doesNotMatch(historySource, /observations\.query/)
  assert.doesNotMatch(historySource, /repositories\.evidence/)
  assert.doesNotMatch(historySource, /limit:\s*5_000/)
  assert.match(historySource, /idx_source_records_native/)
})

test('Pi Live Snapshot 在 Service 与 Worker 双边都保持固定上限', () => {
  assert.match(serviceSource, /LIVE_SNAPSHOT_DEFAULT_LIMIT/)
  assert.match(serviceSource, /LIVE_SNAPSHOT_MAX_LIMIT/)
  assert.match(serviceSource, /runtime\.handle\.snapshot\(since, boundedWindow\)/)
  assert.match(workerSource, /LIVE_SNAPSHOT_DEFAULT_LIMIT\s*=\s*120/)
  assert.match(workerSource, /LIVE_SNAPSHOT_MAX_LIMIT\s*=\s*500/)
  assert.match(workerSource, /entries = all\.slice\(start, end\)/)
  assert.doesNotMatch(workerSource, /entries:\s*since[^\n]*:\s*all\b/)
})
