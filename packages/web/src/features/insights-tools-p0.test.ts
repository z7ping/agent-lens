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

test('global error radar reuses one indexed overview and keeps the single-Agent detail scope', async () => {
  const [insights, api, protocol, handler, css] = await Promise.all([
    source('./InsightsPage.tsx'),
    source('../client/api.ts'),
    source('../../../protocol/src/native-review.ts'),
    source('../../../surface-http/src/native-session-metrics-overview-http.ts'),
    source('../insights.css'),
  ])
  assert.match(insights, /radarApi\.nativeMetricsOverview\(\{/)
  assert.match(insights, /projectId: usage\.filters\.projectId \|\| undefined/)
  assert.match(insights, /from: rangeStart\(usage\.filters\.range\)/)
  assert.match(insights, /controller\.abort\(\)/)
  assert.match(insights, /radarSnapshot\?\.key === radarScopeKey/)
  assert.match(insights, /radarItems\.get\(agent\.sourceId\)/)
  assert.match(insights, /model\.setUsageFilters\(\{ sourceIds: \[agent\.sourceId\] \}\)/)
  assert.match(insights, /aria-pressed=\{selectedSourceId === agent\.sourceId\}/)
  assert.match(insights, /<AgentLogo sourceId=\{agent\.sourceId\} size="compact"\/>/)
  assert.match(api, /nativeMetricsOverview\(options:/)
  assert.match(api, /if\(options\.projectId\)params\.set\('projectId',options\.projectId\)/)
  assert.match(handler, /const items=await Promise\.all\(sourceDefs\.map/)
  assert.match(protocol, /Partial session observations are independent lower bounds/)
  assert.match(css, /\.insight-agent-radar-grid \{/)
  assert.doesNotMatch(css, /!important/)
})

test('radar uses a shared multi-line Button tile rather than overriding fixed Button height', async () => {
  const [insights, domainCss, primitives, sharedCss, globalCss] = await Promise.all([
    source('./InsightsPage.tsx'),
    source('../insights.css'),
    source('../components/ui/Primitives.tsx'),
    source('../components/ui/ui-primitives.css'),
    source('../styles.css'),
  ])
  assert.match(insights, /<Button key=\{agent\.sourceId\} variant="tile"/)
  assert.match(primitives, /export type ButtonVariant = [^\n]*'tile'/)
  assert.match(globalCss, /\.btn \{[\s\S]*?height:\s*30px;/)
  const tileRule = sharedCss.match(/\.btn\.tile \{([^}]*)\}/)?.[1]
  assert.ok(tileRule, 'a multi-line Button must own its geometry')
  for (const expected of [
    /height:\s*auto;/,
    /min-height:\s*88px;/,
    /flex-direction:\s*column;/,
    /align-items:\s*stretch;/,
    /white-space:\s*normal;/,
  ]) assert.match(tileRule, expected)
  assert.match(sharedCss, /\.btn\.tile\[aria-pressed='true'\]/)
  assert.doesNotMatch(domainCss, /\.insight-agent-radar-item\s*\{[^}]*\}/)
  assert.doesNotMatch(domainCss, /\.insight-agent-radar-item\.is-selected\s*\{/)
  assert.match(domainCss, /@media \(max-width: 767\.98px\) \{[\s\S]*?\.insight-agent-radar-grid \{/)
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
