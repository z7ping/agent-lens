import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeSlimGate } from './slim-cutover-gate'

const example={
  identities:{
    oldSessionIdentities:12,nativeIndexed:11,archivedOnly:0,
    missingFromNativeCatalog:1,missingContext:2,
    invalidOldIdentities:0,legacyRecordsWithoutSession:2,nativeMetricsMissingOrStale:3,
  },
  originals:{
    verified:9,partial:1,unavailable:1,drifted:0,unsupported:0,
    catalogEnumerationComplete:false,allCurrentOriginalsVerified:false,
  },
  oldDatabaseUnchanged:false,
}
test('combined gate never treats metadata-only coverage as a safe cutover',()=>{
  const report=summarizeSlimGate(example)
  assert.equal(report.readyToSwitch,false)
  assert.equal(report.oldDatabaseChanged,true)
  assert.equal(report.originalIdentities,12)
  assert.equal(report.missingNativeCatalog,1)
  assert.equal(report.missingSessionContexts,2)
  assert.equal(report.originalContentVerified,9)
  assert.ok(report.blockedBy.includes('old-sessions-missing-native-catalog'))
  assert.equal(report.legacyRecordsWithoutSession,2)
  assert.ok(report.blockedBy.includes('legacy-source-records-without-native-session'))
  assert.ok(report.blockedBy.includes('legacy-database-changed-since-snapshot'))
  assert.ok(report.blockedBy.includes('native-metrics-missing-or-stale'))
  assert.ok(report.blockedBy.includes('original-session-content-unverified'))
})
test('perfect original coverage still cannot silently bypass legacy Writer/Hook/rollback gates',()=>{
  const report=summarizeSlimGate({
    identities:{...example.identities,oldSessionIdentities:2,nativeIndexed:2,
      missingFromNativeCatalog:0,missingContext:0,legacyRecordsWithoutSession:0,
      nativeMetricsMissingOrStale:0},
    originals:{...example.originals,verified:2,partial:0,unavailable:0,
      catalogEnumerationComplete:true,allCurrentOriginalsVerified:true},
    oldDatabaseUnchanged:true,
  })
  assert.equal(report.readyToSwitch,false)
  assert.equal(report.blockedBy.includes('full-consumer-and-legacy-writer-retirement-pending'),true)
  assert.equal(report.blockedBy.includes('old-writer-freeze-and-atomic-swap-not-certified'),true)
  assert.equal(report.blockedBy.includes('hook-and-archival-coverage-not-certified'),true)
  assert.equal(report.oldDatabaseChanged,false)
})

test('partial metric and archived-only sessions cannot be marked cutover-complete',()=>{
  const report=summarizeSlimGate({
    ...example,
    identities:{...example.identities,archivedOnly:1,legacyHookRecords:2,
      nativeMetricsPartial:3},
  })
  assert.equal(report.partialNativeMetrics,3)
  assert.equal(report.legacyHookRecords,2)
  assert.ok(report.blockedBy.includes('native-metrics-partial-not-certified'))
  assert.ok(report.blockedBy.includes('legacy-hook-records-require-archive-verification'))
  assert.ok(report.blockedBy.includes('archived-only-sessions-not-deep-audited'))
})


test('verified old Hook originals remove Hook blocker but cannot bypass Writer retirement',()=>{
  const report=summarizeSlimGate({
    identities:{...example.identities,archivedOnly:0,legacyHookRecords:2,
      legacyRecordsWithoutSession:0,nativeMetricsPartial:0},
    originals:{...example.originals,catalogEnumerationComplete:true,
      allCurrentOriginalsVerified:true},
    oldDatabaseUnchanged:true,
    hooks:{found:2,verified:2,scanComplete:true,allLegacyHookOriginalsVerified:true},
  })
  assert.equal(report.legacyHookOriginalsVerified,2)
  assert.equal(report.legacyHookOriginalsIncomplete,false)
  assert.equal(report.blockedBy.includes('legacy-hook-records-require-archive-verification'),false)
  assert.equal(report.blockedBy.includes('hook-and-archival-coverage-not-certified'),false)
  assert.ok(report.blockedBy.includes('old-writer-freeze-and-atomic-swap-not-certified'))
  assert.equal(report.readyToSwitch,false)
})
