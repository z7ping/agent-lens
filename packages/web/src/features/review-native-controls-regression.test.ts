import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Markdown theme SelectMenu stays above the shared Dialog and owns Escape', () => {
  const selectCss = read('../components/select-menu.css')
  const overlayCss = read('../components/ui/overlay.css')
  const selectLayer = Number(selectCss.match(/\.select-menu-popover\s*\{[^}]*z-index:\s*(\d+)/)?.[1])
  const dialogLayer = Number(overlayCss.match(/\.ui-overlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1])
  assert.ok(selectLayer > dialogLayer, 'portaled menu must not render behind its dialog')
  assert.match(read('../components/AgentManagedFilesDialog.tsx'), /className="managed-file-theme-select"><SelectMenu/)
  assert.match(read('../components/ui/Overlay.tsx'), /\.select-menu-trigger\[aria-expanded="true"\]/)
})

test('native Review filters are functional, but limited to the displayed source-verified window', () => {
  const page = read('./ReviewPage.tsx')
  const session = read('./use-review-session.ts')
  assert.match(session, /if\(detail\.statisticsCompleteness==='window'\)\{\s*setRoundFilter\(filter\)/)
  assert.match(page, /const displayedInteractions = useMemo/)
  assert.match(page, /roundFilter === 'errors'\s*\? round\.errorCount > 0/)
  assert.match(page, /roundFilter === 'latency' \? round\.highLatency === true/)
  assert.match(page, /\{displayedInteractions\.map\(/)
  assert.match(page, /\{!displayedInteractions\.length &&/)
  assert.doesNotMatch(page, /disabled=\{roundFilterLoading \|\| detail\.statisticsCompleteness === 'window'\}/)
})

test('native jump-to-latest keeps user intent while the sparse index scans', () => {
  const page = read('./ReviewPage.tsx')
  const session = read('./use-review-session.ts')
  assert.match(session, /pendingLatestNativeNavigationRef\.current=detail\.id/)
  assert.match(session, /if\(pendingLatestNativeNavigationRef\.current===id\)/)
  assert.match(session, /await model\.jumpToLatestReviewDetail\(\)/)
  assert.match(page, /nativeTurnIndex\?\.state === 'available' && nativeTurnIndex\.coverage === 'complete'/)
  assert.doesNotMatch(page, /!\(nativeTurnIndex\?\.state==='available' && nativeTurnIndex\.coverage==='complete'/)
})
