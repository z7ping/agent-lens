import assert from 'node:assert/strict'
import test from 'node:test'
import { dataRuntimeStorageInternals } from './storage-proxy'

test('Tool Fact readiness stays foreground while maintenance coverage and cursor repair use maintenance reader budget', () => {
  const coveragePath = ['projectionBackfill', 'toolUsageFactCoverage']
  const maintenanceCoveragePath = ['projectionBackfill', 'toolUsageFactCoverageForMaintenance']
  const repairPath = ['projectionBackfill', 'repairToolUsageFactCursor']
  const backfillPath = ['projectionBackfill', 'backfillToolUsageFacts']

  assert.equal(dataRuntimeStorageInternals.isReadPath(coveragePath), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(coveragePath), false)
  assert.equal(dataRuntimeStorageInternals.timeoutFor(coveragePath, true), 2_000)

  assert.equal(dataRuntimeStorageInternals.isReadPath(maintenanceCoveragePath), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(maintenanceCoveragePath), true)
  assert.equal(dataRuntimeStorageInternals.timeoutFor(maintenanceCoveragePath, true), 120_000)

  assert.equal(dataRuntimeStorageInternals.isReadPath(repairPath), true)
  assert.equal(dataRuntimeStorageInternals.isMaintenanceReadPath(repairPath), true)
  assert.equal(dataRuntimeStorageInternals.timeoutFor(repairPath, true), 120_000)

  assert.equal(dataRuntimeStorageInternals.isMaintenanceOperation(backfillPath), true)
  assert.equal(dataRuntimeStorageInternals.timeoutFor(backfillPath, false), 120_000)
})

test('only background maintenance writes are excluded from foreground Writer backlog', () => {
  const maintenanceWrites = [
    ['maintenanceJobs', 'ensure'],
    ['maintenanceJobs', 'update'],
    ['projectionBackfill', 'backfillToolUsageFacts'],
    ['projectionBackfill', 'backfillUnknownObservations'],
    ['sessionSummaryProjection', 'rebuild'],
    ['maintenance', 'ensureDeferredIndexes'],
  ]
  for (const path of maintenanceWrites) {
    assert.equal(
      dataRuntimeStorageInternals.isMaintenanceOperation(path),
      true,
      `${path.join('.')} must use the maintenance Writer queue`,
    )
  }

  const foregroundWrites = [
    ['repositories', 'observations', 'upsert'],
    ['repositories', 'sourceRecords', 'insert'],
    ['checkpoints', 'set'],
  ]
  for (const path of foregroundWrites) {
    assert.equal(
      dataRuntimeStorageInternals.isMaintenanceOperation(path),
      false,
      `${path.join('.')} must remain visible to foreground Writer backlog`,
    )
  }
})
