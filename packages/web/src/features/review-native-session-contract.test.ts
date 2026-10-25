import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url),'utf8')
const hook=read('./use-review-session.ts')
const page=read('./ReviewPage.tsx')
const model=read('../client/model-review.ts')
const storage=read('../../../storage-sqlite/src/native-session-catalog.ts')
const api=read('../client/api.ts')

test('native-only entries use indexed SQL source identity dedup before pagination',()=>{
  assert.match(storage,/review_session_id IS NOT NULL/)
  assert.match(storage,/linked\.source_id = native_session_catalog\.source_id/)
  assert.match(storage,/linked\.installation_id = native_session_catalog\.installation_id/)
  assert.match(storage,/linked\.native_session_id = native_session_catalog\.native_session_id/)
  assert.match(storage,/stored\.logical_session_id = linked\.logical_session_id/)
  assert.match(hook,/onlyWithoutLegacyReview: true/)
  assert.match(hook,/origin: 'native'/)
  assert.match(hook,/nativeCursor/)
  assert.match(hook,/loadMoreNativeSessions/)
})

test('opening a certified native Review lazily rebuilds only missing or stale numerical metrics',()=>{
  assert.match(model,/if \(summary\.locationKind === 'native'\)/)
  assert.doesNotMatch(model,/summary\.sourceId === 'pi' && summary\.locationKind/)
  assert.match(model,/this\.api\.nativeMetricStatus\(id, signal\)/)
  assert.match(model,/status\.state === 'missing' \|\| status\.state === 'stale'/)
  assert.match(model,/this\.api\.rebuildNativeMetric\(id, signal\)/)
  assert.match(api,/\/metrics\/rebuild/)
  assert.match(api,/method: 'POST'/)
})

test('native details render inside the only existing Review TaskSurface, with no fabricated controls',()=>{
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1)
  assert.match(page,/entry\.origin === 'native'/)
  assert.match(page,/onClick=\{\(\) => select\(item\.id\)\}/)
  assert.match(model,/id\.startsWith\('native:'\)/)
  assert.match(model,/nativeReviewDetail\(summary, window\)/)
  assert.match(page,/statisticsCompleteness === 'window'/)
  assert.match(page,/nativeHasMore/)
})
