import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

async function source(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
}

test('both Insights tabs use a single shared Agent scope, never All Agents', async () => {
  const [insights, tools, app] = await Promise.all([
    source('./InsightsPage.tsx'),
    source('./ToolsPage.tsx'),
    source('../App.tsx'),
  ])
  for (const page of [insights, tools]) {
    assert.match(page, /agentSelection=\{\{ mode: 'single'/)
    assert.doesNotMatch(page, /agentSelection=\{\{ mode: 'multiple'/)
    assert.match(page, /model\.setUsageFilters\(\{ sourceIds: \[sourceId\], projectId: '' \}\)/)
    assert.match(page, /const relaxFilters = \(\) => model\.setUsageFilters\(\{ projectId: '', range: 'all' \}\)/)
  }
  assert.match(insights, /const usage = useClientSnapshotField\(model, 'usage'\)/)
  assert.match(insights, /matchingScope \? insights\.response : null/)
  assert.match(app, /selected\?\.length === 1/)
  assert.match(app, /localStorage\.getItem\('agent-lens\.insights-tools\.source-id'\)/)
})

test('unverified native tool observations are a separate lower-bound group', async () => {
  const tools = await source('./ToolsPage.tsx')
  assert.match(tools, /if\(left\.partial!==right\.partial\)/)
  assert.match(tools, /nativeToolRows\.filter\(tool=>!tool\.partial\)\.map\(renderNativeToolRow\)/)
  assert.match(tools, /nativeToolRows\.filter\(tool=>tool\.partial\)\.map\(renderNativeToolRow\)/)
  assert.match(tools, /page\.nativeObservedGroup/)
})

test('tool-table inherits default text color; semantic states do not require selector escalation', async () => {
  const [tools, styles] = await Promise.all([
    source('./ToolsPage.tsx'),
    source('../tools.css'),
  ])
  assert.match(tools, /<td className=\{tool\.errorCount \? 'cell-danger' : 'cell-muted'\}>\{tool\.errorCount\}<\/td>/)
  assert.match(styles, /\.tool-table\s*\{[^}]*color:\s*var\(--al-ink-2\)/)
  const cellRule=styles.match(/\.tool-table td\s*\{([^}]*)\}/)?.[1]
  assert.ok(cellRule,'table cell geometry rule must remain present')
  assert.doesNotMatch(cellRule,/\bcolor\s*:/)
  assert.doesNotMatch(styles,/\.tool-table td\.cell-/)
  assert.match(styles, /\.cell-danger\s*\{[^}]*color:\s*var\(--al-danger\)/)
  assert.match(styles, /\.cell-slow\s*\{[^}]*color:/)
  assert.match(styles, /\.cell-muted\s*\{[^}]*color:\s*var\(--al-muted-2\)/)
})
