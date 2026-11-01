import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url),'utf8')
const hook=read('./use-review-session.ts')
const page=read('./ReviewPage.tsx')
const model=read('../client/model-review.ts')
const storage=read('../../../storage-sqlite/src/native-session-catalog.ts')
const api=read('../client/api.ts')

test('native-only entries use their catalog identity and stable pagination',()=>{
  assert.match(storage,/review_session_id IS NOT NULL/)
  assert.match(storage,/ORDER BY last_activity_at DESC,source_id DESC,installation_id DESC,native_session_id DESC,location_kind DESC/)
  assert.match(storage,/WHERE ctx\.source_id=native_session_catalog\.source_id/)
  assert.match(storage,/ctx\.installation_id=native_session_catalog\.installation_id/)
  assert.match(storage,/ctx\.native_session_id=native_session_catalog\.native_session_id/)
  assert.match(hook,/filters\.projectId \? \{ projectId: filters\.projectId \} : \{\}/)
  assert.match(hook,/item\.metricsState === 'complete'/)
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

test('oversized source records use the existing Review disclosure and bounded verified fragments',()=>{
  assert.match(page,/review\.error\.includes\('native-record-too-large'\)/)
  assert.match(page,/hookApi\.locateOversizedNativeRecord\(id/)
  assert.match(page,/hookApi\.nativeRecordTextFragments\(id/)
  assert.match(page,/hookApi\.nativeRecordMediaChunk\(id/)
  assert.match(page,/<ImagePreview src=\{oversized\.mediaDataUrl\}/)
  assert.match(page,/const maxBase64=8\*1024\*1024/)
  assert.match(page,/page\.recordSha256!==current\.recordSha256/)
  assert.match(api,/record-fragments\/media/)
  assert.match(page,/found\.nextCursor\?\{searchCursor:found\.nextCursor\}:\{\}/,
    'a verified following record should remain discoverable without restarting the search')
  assert.match(page,/page\.coverage!=='fragment-only'/)
  assert.match(page,/page\.recordSha256!==current\.recordSha256/)
  assert.match(page,/page\.fragments\.some\(\(piece,index\)=>piece\.ordinal!==next\+index\)/)
  assert.match(page,/fragments:\[\.\.\.current\.fragments,\.\.\.page\.fragments\]\.slice\(-16\)/)
  assert.match(page,/<Disclosure/)
  assert.match(page,/nativeOversizedMore/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1,
    'the fallback must not mount an independent Review UI')
})

test('native oversized call and result linking reuses catalog-scoped fragment APIs and shared Review controls',()=>{
  assert.match(page,/hookApi\.nativeRecordToolLink\(id/)
  assert.match(page,/hookApi\.nativeRecordTextFragments\(id/)
  assert.match(page,/nativeOversizedFindResultMore/)
  assert.match(page,/nativeOversizedLinkedMore/)
  assert.match(page,/page\.recordSha256!==result\.match\.recordSha256/)
  assert.match(page,/item\.callKey!==fragment\.callKey/)
  assert.match(page,/fragments:\[\.\.\.match\.fragments,\.\.\.page\.fragments\]\.slice\(-16\)/)
  assert.match(api,/record-fragments\/link/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1)
})

test('partial native TaskSurface keeps its content while locating the exact oversized record',()=>{
  assert.match(page,/detail\?\.id===review\.selectedId/)
  assert.match(page,/detail\.nativeOversizedRecordSearchCursor/)
  assert.match(page,/searchCursor=detail\.nativeOversizedRecordSearchCursor/)
  assert.match(page,/hookApi\.locateOversizedNativeRecord\(id/)
  assert.match(page,/summary=\{t\('local\.roundNav\.nativeOversizedTitle'\)\}/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1,
    'the fallback must reuse the existing shared TaskSurface')
})

test('oversized block outline stays in the existing fragment-only Review disclosure',()=>{
  assert.match(page,/contentBlocks:\s*page\.contentBlocks/)
  assert.match(page,/oversized\.contentBlocks\?\.map\(block/)
  assert.match(page,/nativeOversizedBlocksTruncated/)
  assert.match(page,/nativeOversizedBlockFragments/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1,
    'native structure must not introduce a second TaskSurface renderer')
})

test('verified zero-fragment tool blocks reuse the same native correlation action',()=>{
  assert.match(page,/block\.kind==='tool-call'&&block\.fragmentCount===0/)
  assert.match(page,/ordinal:-1,contentIndex:block\.contentIndex/)
  assert.match(page,/anchorContentIndex===undefined/)
  assert.match(page,/contentIndex:anchorContentIndex/)
  assert.match(api,/params\.set\('contentIndex',String\(options\.contentIndex\)\)/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1)
})

test('formal TaskSurface images reuse one SHA-bound lazy preview reader',()=>{
  const message=read('./TaskMessage.tsx')
  const round=read('./ReviewRoundPresentation.tsx')
  const loader=read('../client/native-media-preview.ts')
  const client=read('../client/model-base.ts')
  assert.match(page,/loadImage=\{model\.reviewAttachmentImage\}/)
  assert.match(round,/loadImage\(node\.id,attachment,signal\)/)
  assert.match(message,/loadImage&&attachment\.nativeMedia/)
  assert.match(message,/onClick=\{\(\)=>void loadNativeImage\(index,attachment\)\}/)
  assert.match(loader,/page\.recordSha256!==ref\.recordSha256/)
  assert.match(loader,/page\.contentIndex!==ref\.contentIndex/)
  assert.match(client,/return loadNativeImagePreview\(this\.api,ref,signal\)/)
  assert.match(page,/await loadNativeImagePreview\(hookApi/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1)
})

test('verified giant native scalar text pages inside existing shared TaskSurface',()=>{
  const native=read('../../../projection-review/src/native-window.ts')
  const round=read('./ReviewRoundPresentation.tsx')
  const source=read('../../../source-pi/src/index.ts')
  const fragments=read('../../../surface-http/src/native-record-fragments-http.ts')
  assert.match(source,/verifiedLargeTextRecord:/)
  assert.match(native,/nativeLazyBodies\.set\(item\.id/)
  assert.match(native,/nativeLazyText:/)
  assert.match(round,/nativeRecordTextFragments\(sessionId/)
  assert.match(round,/result\.recordSha256!==verified\.recordSha256/)
  assert.match(round,/result\.totalTextFragments!==verified\.totalTextFragments/)
  assert.match(round,/result\.fragments\.some\(\(piece,index\)=>piece\.ordinal!==offset\+index/)
  assert.match(round,/nativeBodyPrevious/)
  assert.match(round,/nativeBodyNext/)
  assert.match(fragments,/structuralBodyCursor/)
  assert.equal((page.match(/<TaskSurface\b/g)??[]).length,1)
})
