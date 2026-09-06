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
