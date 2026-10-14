import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')

test('desktop viewport evidence keeps a fast CDP probe with a size-checked Electron fallback', () => {
  assert.match(source, /win\.setContentSize\(viewport\.width, viewport\.height\)/)
  assert.match(source, /Page\.captureScreenshot/)
  assert.match(source, /captureBeyondViewport:\s*false/)
  assert.match(source, /\}\), 3_000, `\$\{viewport\.width\}×\$\{viewport\.height\} \$\{theme\} CDP 截图`\)/)
  assert.match(source, /win\.webContents\.capturePage\(\)/)
  assert.match(source, /image\.isEmpty\(\)/)
  assert.match(source, /Math\.abs\(size\.width - viewport\.width\) > 2/)
  assert.match(source, /Math\.abs\(size\.height - viewport\.height\) > 2/)
})

test('switch stability waits for the async task list without weakening the 100-switch performance gate', () => {
  assert.match(source, /for \(let attempt = 0; attempt < 80; attempt \+= 1\)/)
  assert.match(source, /if \(initialCount >= 2\) break/)
  assert.match(source, /await delay\(50\)/)
  assert.match(source, /任务列表在 4 秒内未就绪/)
  assert.match(source, /skipped: true[^\n]+ok: false/)
  assert.match(source, /clickTaskSequence\(win, 100\)/)
  assert.match(source, /withTimeout\(runSwitchStability\(switchWin\), 25_000, '100 次任务切换稳定性'\)/)
  assert.doesNotMatch(source, /真实任务不足 2 条[^\n]+ok: true/)
})

test('viewport geometry accepts only the new Task Center context lane widths, including 1280/1366', () => {
  assert.match(source, /viewport\.width >= 1200 \? 300 : viewport\.width >= 992 \? 260/)
  assert.doesNotMatch(source, /viewport\.width >= 1200 \? 276 : viewport\.width >= 992 \? 246/)
  assert.match(source, /Math\.abs\(geometry\.railWidth - expectedRail\) <= 2/)
  assert.match(source, /任务列表与详情发生重叠/)
})

test('real Review acceptance expands the single Process disclosure before checking tool facts', () => {
  assert.match(source, /document\.querySelector\('\.task-review-process'\)/)
  assert.match(source, /process\.querySelector\(':scope > summary'\)\?\.click\(\)/)
  assert.match(source, /state\.processExpanded/)
  assert.match(source, /state\.toolCount >= 1/)
  assert.doesNotMatch(source, /toolCount:\s*1\b/)
})

test('Task Center viewport acceptance checks current search/filter layout and each native Tool row shape', () => {
  assert.match(source, /const searchPanel = pick\('\.task-center-search-panel'\)/)
  assert.match(source, /const quickFilters = pick\('\.task-center-quick-filters'\)/)
  assert.match(source, /const workspaceTopbar = pick\('\.workspace-topbar'\)/)
  assert.doesNotMatch(source, /const toolbar = pick\('\.task-center-toolbar'\)/)
  assert.match(source, /!value\.searchPanel \|\| !value\.quickFilters \|\| !value\.workspaceTopbar/)
  assert.match(source, /for \(const \[index, row\] of p\.toolRowsLayout\.entries\(\)\)/)
  assert.match(source, /const expectedColumns = 4/)
  assert.match(source, /expandedToolCallCount/)
  assert.match(source, /invalidToolSections/)
  assert.match(source, /row\.columnCount !== expectedColumns/)
  assert.match(source, /Tool Row 内部横向溢出/)
})

test('Codex real desktop acceptance validates folded Process/Tool and explicit Inspector click', () => {
  const codex = readFileSync(new URL('./codex-semantics-real.mjs', import.meta.url), 'utf8')
  assert.match(codex, /initial\.closedCount !== initial\.groupCount/)
  assert.match(codex, /initiallyClosedToolCount !== value\.toolCount/)
  assert.match(codex, /data-tool-section="input"/)
  assert.match(codex, /data-tool-section="output"/)
  assert.match(codex, /button\.task-tool-inspect/)
  assert.match(codex, /querySelector\(':scope > summary'\)\?\.click\(\)/)
  assert.doesNotMatch(codex, /聚合执行过程未默认展开/)
})
