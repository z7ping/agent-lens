import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(new URL('./Primitives.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./ui-primitives.css', import.meta.url), 'utf8')
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8')
const overlayCss = readFileSync(new URL('./overlay.css', import.meta.url), 'utf8')
const piStartup = readFileSync(new URL('../PiStartupDisclosure.tsx', import.meta.url), 'utf8')
const piStartupCss = readFileSync(new URL('../pi-startup-disclosure.css', import.meta.url), 'utf8')
const taskViewCss = readFileSync(new URL('../../task-view-options.css', import.meta.url), 'utf8')
const composerPill = readFileSync(new URL('../ComposerPillSelect.tsx', import.meta.url), 'utf8')
const stateViews = readFileSync(new URL('../StateViews.tsx', import.meta.url), 'utf8')
const piLivePage = readFileSync(new URL('../../features/PiLivePage.tsx', import.meta.url), 'utf8')
const piLiveCss = readFileSync(new URL('../../pi-live.css', import.meta.url), 'utf8')
const taskCenterPage = readFileSync(new URL('../../features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const taskCenterCss = readFileSync(new URL('../../task-center.css', import.meta.url), 'utf8')
const backupPage = readFileSync(new URL('../../features/BackupPage.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../../backup.css', import.meta.url), 'utf8')
const toolsPage = readFileSync(new URL('../../features/ToolsPage.tsx', import.meta.url), 'utf8')
const toolsCss = readFileSync(new URL('../../tools.css', import.meta.url), 'utf8')
const insightsPage = readFileSync(new URL('../../features/InsightsPage.tsx', import.meta.url), 'utf8')
const agentRules = readFileSync(new URL('../../../../../AGENTS.md', import.meta.url), 'utf8')

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tsxFiles(path) : entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('shared UI primitives expose the first unified component set', () => {
  for (const name of ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'StatusBadge', 'Disclosure', 'Toolbar', 'ToolbarGroup']) {
    assert.match(source, new RegExp(`export function ${name}\\b`))
  }
  assert.match(source, /role = 'toolbar'/)
  assert.match(index, /export \{ Dialog, Drawer \} from '\.\/Overlay'/)
  assert.match(index, /export \{ SelectMenu \} from '\.\.\/SelectMenu'/)
  assert.match(index, /ToolbarGroupProps/)
  assert.match(index, /ToolbarProps/)
  assert.match(index, /export \{ UiIcon \} from '\.\.\/UiIcon'/)
})

test('界面图标统一走 UiIcon，页面不再保留字符占位或重复 SVG', () => {
  const webSource = fileURLToPath(new URL('../..', import.meta.url))
  const files = tsxFiles(webSource)
  const allowedSvgOwners = new Set(['UiIcon.tsx', 'ToolKindIcon.tsx'])
  for (const file of files) {
    const fileSource = readFileSync(file, 'utf8')
    assert.doesNotMatch(fileSource, /[×←→↑↓⌄⌕✓]/, `${file} 不得使用字符充当界面图标`)
    assert.doesNotMatch(fileSource, />\s*\+\s+[^<{]+</, `${file} 不得使用加号字符充当新增图标`)
    if (!allowedSvgOwners.has(file.split(/[\\/]/).at(-1)!)) {
      assert.doesNotMatch(fileSource, /<svg\b/, `${file} 的通用图标应复用 UiIcon`)
    }
    for (const match of fileSource.matchAll(/<UiIcon\b[^>]*\bsize=\{(\d+)\}/g)) {
      assert.ok(['12', '14', '16', '20'].includes(match[1]), `${file} 的 UiIcon 尺寸 ${match[1]} 不在统一档位内`)
    }
    assert.doesNotMatch(fileSource, /<button[^>]+className="[^"]*(?:icon-button|theme-toggle|pi-live-menu|pi-live-send)/, `${file} 的纯图标操作应复用 IconButton`)
  }
  assert.doesNotMatch(`${piStartupCss}\n${taskViewCss}`, /content:\s*['"][^'"]*[›⌄×←→↑↓⌕✓][^'"]*['"]/, 'CSS 不得通过 content 注入字符图标')
})

test('shared controls keep the frozen size and typography contracts', () => {
  assert.match(css, /\.ui-icon-button \{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/)
  assert.match(css, /\.ui-icon-button\.is-small \{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/)
  assert.match(css, /\.ui-field \{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/)
  assert.match(css, /\.ui-status-badge \{[\s\S]*?font-size:\s*12px;/)
  assert.doesNotMatch(overlayCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('shared primitives consume semantic tokens instead of page palettes', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(overlayCss, /#[0-9a-fA-F]{3,8}\b/)
  assert.match(css, /var\(--al-accent\)/)
  assert.match(css, /var\(--al-danger\)/)
  assert.match(css, /var\(--al-line-strong\)/)
})

test('Dialog and Drawer own the common accessibility behavior', () => {
  assert.match(overlay, /event\.key === 'Escape'/)
  assert.match(overlay, /event\.key !== 'Tab'/)
  assert.match(overlay, /aria-modal="true"/)
  assert.match(overlay, /previous\?\.focus/)
  assert.match(overlay, /title: ReactNode/)
  assert.match(overlay, /closeDisabled\?: boolean/)
  assert.match(overlay, /disabled=\{closeDisabled\}/)
  assert.match(overlay, /export function Dialog/)
  assert.match(overlay, /export function Drawer/)
})

test('Pi startup actions consume the shared Button contract', () => {
  assert.match(piStartup, /import \{ Button \} from '\.\/ui'/)
  assert.match(piStartup, /<Button size="small"/)
  assert.match(piStartup, /variant="primary"/)
  assert.match(piStartup, /variant="danger"/)
  assert.doesNotMatch(piStartupCss, /\.pi-startup-actions button\s*\{/)
  assert.doesNotMatch(piStartupCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('existing shared composites route common controls through the UI layer', () => {
  assert.match(composerPill, /import \{ SelectMenu, type SelectMenuOption \} from '\.\/ui'/)
  assert.match(stateViews, /import \{ Button \} from '\.\/ui'/)
  assert.match(stateViews, /<Button variant="primary"/)
  assert.doesNotMatch(stateViews, /className="state-button/)
})

test('Pi Live routes common actions and fields through the UI layer', () => {
  assert.match(piLivePage, /import \{ Button, IconButton, Input, Textarea \} from '\.\.\/components\/ui'/)
  assert.match(piLivePage, /<Button size="small" variant="primary" onClick=\{\(\) => onAnswer/)
  assert.match(piLivePage, /<Textarea className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<Input className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<IconButton[\s\S]*?className="pi-live-editor-action"/)
  assert.match(piLivePage, /<IconButton variant="primary" className="pi-live-send"/)
  assert.match(piLivePage, /className="pi-live-queue-action"/)

  for (const obsolete of [
    /\.pi-live-blocking button\s*\{/,
    /\.pi-live-startup-queue button\s*\{/,
    /\.pi-live-queue-item button\s*\{/,
    /\.pi-live-editor-toolbar button\s*\{/,
    /\.pi-live-compose-settings select\s*\{/,
  ]) assert.doesNotMatch(piLiveCss, obsolete)
  assert.match(piLiveCss, /\.pi-live-model-picker \{[\s\S]*?width:\s*clamp/)
  assert.match(piLiveCss, /\.pi-live-thinking-picker \{[\s\S]*?width:\s*clamp/)
})

test('Task Center toolbar and common actions consume the UI layer', () => {
  assert.match(taskCenterPage, /import \{ Button, IconButton, Input, SelectMenu, Toolbar \} from '\.\.\/components\/ui'/)
  assert.doesNotMatch(taskCenterPage, /from '\.\.\/components\/SelectMenu'/)
  assert.match(taskCenterPage, /<Toolbar className="task-center-toolbar" aria-label="筛选历史任务">/)
  assert.match(taskCenterPage, /<Input className="filter search-filter"/)
  assert.match(taskCenterPage, /<IconButton onClick=\{\(\) => void model\.refreshReview\(\)\}/)
  assert.match(taskCenterPage, /<Button size="small" variant="primary" onClick=\{newTask\}>/)
  assert.match(taskCenterPage, /<Button variant="primary" loading=\{starting\}/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-toolbar \.icon-button/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-rail-head \.btn\s*\{/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-new-actions \.btn\s*\{[^}]*min-height:/s)
  assert.match(taskCenterCss, /\.task-center-toolbar \.ui-icon-button/)
})

test('Asset Backup consumes shared controls and Overlay primitives', () => {
  assert.match(backupPage, /import \{ Button, Dialog, Drawer, Toolbar \} from '\.\.\/components\/ui'/)
  assert.match(backupPage, /<Toolbar className="workspace-toolbar" aria-label="资产备份工具栏">/)
  assert.match(backupPage, /<Button className="toolbar-end" loading=\{busy === 'import'\}/)
  assert.match(backupPage, /<Button variant="primary" loading=\{busy === 'create'\}/)
  assert.match(backupPage, /<Drawer[\s\S]*?className="backup-data-drawer"/)
  assert.match(backupPage, /<Drawer[\s\S]*?className="backup-preview-drawer"/)
  assert.match(backupPage, /<Dialog[\s\S]*?className="backup-confirm-overlay"/)
  assert.doesNotMatch(backupPage, /className="scrim show/)
  assert.doesNotMatch(backupPage, /className="drawer show/)
  assert.doesNotMatch(backupPage, /backup-confirm-dialog/)
  assert.doesNotMatch(backupPage, /window\.addEventListener\('keydown', closeOnEscape\)/)
  assert.doesNotMatch(backupCss, /\.backup-confirm-dialog\b/)
  assert.doesNotMatch(backupCss, /\.backup-confirm-scrim\b/)
  assert.doesNotMatch(backupCss, /@media \(max-width: (?:1180|820|640)px\)/)
  assert.doesNotMatch(backupCss, /\.snapshot-create-button\s*\{[^}]*height\s*:/s)
})

test('Tools and Insights consume shared toolbar and overlay primitives', () => {
  assert.match(toolsPage, /import \{ Drawer, IconButton, SelectMenu, Toolbar \} from '\.\.\/components\/ui'/)
  assert.match(toolsPage, /<Toolbar className="workspace-toolbar" aria-label="工具分析筛选">/)
  assert.match(toolsPage, /<Drawer[\s\S]*?className="tool-drill-overlay"/)
  assert.doesNotMatch(toolsPage, /tool-drawer-scrim|tool-drill-drawer|window\.addEventListener\('keydown'/)
  assert.doesNotMatch(toolsCss, /\.tool-drawer-scrim\b|\.tool-drill-drawer\b|\.tool-drill-head\b/)
  assert.doesNotMatch(toolsCss, /@media \(max-width: (?:1100|760|560)px\)/)
  assert.match(toolsCss, /@media \(max-width: 991\.98px\)/)
  assert.match(toolsCss, /@media \(max-width: 767\.98px\)/)
  assert.match(toolsCss, /@media \(max-width: 575\.98px\)/)

  assert.match(insightsPage, /import \{ IconButton, SelectMenu, Toolbar, UiIcon \} from '\.\.\/components\/ui'/)
  assert.doesNotMatch(insightsPage, /from '\.\.\/components\/SelectMenu'/)
  assert.match(insightsPage, /<Toolbar className="workspace-toolbar" aria-label="使用洞察筛选">/)
  assert.match(insightsPage, /<IconButton className="toolbar-end"/)
})

test('repository agent rules require reuse of shared primitives', () => {
  assert.match(agentRules, /UI \/ 组件契约（强制）/)
  assert.match(agentRules, /已有对应 Primitive 时，页面不得自行重新实现/)
  assert.match(agentRules, /TaskSurface/)
  assert.match(agentRules, /正常可见文字不得低于 `12px`/)
  assert.match(agentRules, /### 图标规范/)
  assert.match(agentRules, /禁止用 `× \/ ← \/ → \/ ↑ \/ ↓ \/ ✓ \/ ⌄ \/ ⌕`/)
})
