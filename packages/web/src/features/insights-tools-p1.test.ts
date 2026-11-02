import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

async function source(relative:string){
  return readFile(fileURLToPath(new URL(relative,import.meta.url)),'utf8')
}

test('high-frequency tool analysis uses URL-backed full reading view, never Drawer',async()=>{
  const [tools,insights]=await Promise.all([
    source('./ToolsPage.tsx'),source('./InsightsPage.tsx'),
  ])
  assert.doesNotMatch(tools,/<Drawer/)
  assert.doesNotMatch(insights,/<Drawer/)
  assert.match(tools,/const activeNativeTool=/)
  assert.match(tools,/const activeLegacyTool=/)
  assert.match(tools,/const closeToolDetail=/)
  assert.match(tools,/pathname:'\/tools'/)
  assert.match(tools,/page\.backToTools/)
  assert.match(tools,/showingFailures/)
  assert.match(insights,/navigate\('\/tools\?view=failures'\)/)
})

test('native trend is explicitly separate from legacy and from event timestamps',async()=>{
  const [insights,storage,server,contribution]=await Promise.all([
    source('./InsightsPage.tsx'),
    source('../../../storage-sqlite/src/native-session-metrics.ts'),
    source('../../../surface-http/src/slim-server.ts'),
    source('../../../surface-http/src/native-metrics-contribution.ts'),
  ])
  assert.match(insights,/verifiedNative\?\.trend/)
  assert.match(insights,/page\.nativeTrendDescription/)
  assert.match(storage,/WHERE metric_status='complete' AND last_activity_at IS NOT NULL/)
  assert.match(storage,/ORDER BY date DESC LIMIT 32/)
  assert.match(server,/includeTrend:Boolean\(scope\.from\)/)
  assert.match(contribution,/scope\.includeTrend/)
})

test('native error samples preserve verified round navigation and virtual anchor',async()=>{
  const [failures,review,session,surface,url]=await Promise.all([
    source('./NativeFailureExamples.tsx'),
    source('./ReviewPage.tsx'),
    source('./use-review-session.ts'),
    source('./TaskSurface.tsx'),
    source('../client/useReviewUrlSync.ts'),
  ])
  assert.match(failures,/focusTurn=\$\{encodeURIComponent\(String\(example\.ordinal\)\)\}/)
  assert.match(review,/focusTurnTarget=\{/)
  assert.match(session,/jumpToReviewInteraction\(item\.ordinal\)/)
  assert.match(surface,/pendingTurnRailTargetRef\.current=\{id:focusTurnTarget\.key,ordinal:focusTurnTarget\.ordinal\}/)
  assert.match(url,/nextParams\.set\('focusTurn',focusTurn\)/)
})

test('native statistics show compact status and date basis without repeated explanation blocks',async()=>{
  const [insights,tools,zh,en]=await Promise.all([
    source('./InsightsPage.tsx'),
    source('./ToolsPage.tsx'),
    source('../i18n/zh-CN/insights-tools.ts'),
    source('../i18n/en-US/insights-tools.ts'),
  ])
  assert.match(insights,/title=\{t\(data\.meta\.mode === 'native-only'/)
  assert.match(insights,/page\.nativeTrendBasis/)
  assert.doesNotMatch(insights,/<small>\{data\.meta\.mode==='native-only'/)
  assert.doesNotMatch(insights,/<section className="insight-method-note" role="status">/)
  assert.match(tools,/<StatusBadge tone=\{nativeMetrics\.coverage/)
  assert.match(tools,/page\.nativeObservedShort/)
  assert.match(tools,/title=\{key==='averageDurationMs'/)
  assert.doesNotMatch(tools,/<small>\{t\('page\.nativeDurationNote'\)}/)
  assert.doesNotMatch(tools,/<span>\{t\('page\.nativeOnlyModeNote'\)}/)
  assert.doesNotMatch(tools,/<div className="tool-drill-note">\{t\('page\.nativeOnlyModeNote'\)}/)
  for(const translations of [zh,en]){
    assert.match(translations,/nativeTrendBasis:/)
    assert.match(translations,/nativePartialStatus:/)
    assert.match(translations,/nativeCompleteStatus:/)
    assert.match(translations,/nativeObservedShort:/)
  }
})
