import assert from 'node:assert/strict'
import test from 'node:test'
import { slimStorageRootAllowed } from './slim-rpc-policy'

test('Slim Data Runtime permits only current-state and numerical methods',()=>{
  for(const path of [
    ['health'],['nativeSessionList','query'],
    ['nativeSessionCatalog','get'],['nativeSessionCatalog','upsert'],
    ['nativeSessionMetrics','overview'],['nativeSessionMetrics','replace'],
    ['nativeFacets','query'],
    ['identity','resolveInstallation'],['nativeSessionContexts','upsert'],
    ['repositories','hosts','get'],['repositories','installations','get'],
    ['assets','recordState'],['assetInventory','listByInstallation'],
  ]) assert.equal(slimStorageRootAllowed(path),true,path.join('.'))
})
test('Slim Data Runtime cannot reflect into legacy Writer or SQLite internals',()=>{
  for(const path of [
    ['repositories','observations','query'],['repositories','evidence','put'],
    ['repositories','sessions','getSourceSession'],
    ['nativeSessionCatalog','claimLegacyWrite'],
    ['nativeSessionCatalog','getSessionWriteMode'],
    ['nativeSessionCatalog','executor','run'],
    ['nativeSessionList','executor','db','prepare'],
    ['nativeSessionMetrics','constructor'],
    ['identity','executor','db','exec'],
    ['replication','get'],['sessionSummaries','query'],
    ['sourceRawAudit','query'],['taskFileChanges','query'],
    ['maintenance','compact'],['db','exec'],
    ['executor','run'],['__proto__','constructor'],
    ['health','constructor'],
  ]) assert.equal(slimStorageRootAllowed(path),false,path.join('.'))
})
