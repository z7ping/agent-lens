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
const reviewPage = readFileSync(new URL('../../features/ReviewPage.tsx', import.meta.url), 'utf8')
const reviewCss = readFileSync(new URL('../../review.css', import.meta.url), 'utf8')
const backupPage = readFileSync(new URL('../../features/BackupPage.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../../backup.css', import.meta.url), 'utf8')
const toolsPage = readFileSync(new URL('../../features/ToolsPage.tsx', import.meta.url), 'utf8')
const toolsCss = readFileSync(new URL('../../tools.css', import.meta.url), 'utf8')
const insightsPage = readFileSync(new URL('../../features/InsightsPage.tsx', import.meta.url), 'utf8')
const insightsCss = readFileSync(new URL('../../insights.css', import.meta.url), 'utf8')
const agentsPage = readFileSync(new URL('../../features/AgentsPage.tsx', import.meta.url), 'utf8')
const agentsCss = readFileSync(new URL('../../agents.css', import.meta.url), 'utf8')
const agentsResponsiveCss = readFileSync(new URL('../../agent-insights-responsive.css', import.meta.url), 'utf8')
const workspaceSidebar = readFileSync(new URL('../WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const workspaceSidebarCss = readFileSync(new URL('../workspace-sidebar.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const agentRules = readFileSync(new URL('../../../../../AGENTS.md', import.meta.url), 'utf8')

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tsxFiles(path) : entry.isFile() && entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('shared UI primitives expose the unified component set', () => {
  for (const name of ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'StatusBadge', 'Disclosure', 'Toolbar', 'ToolbarGroup']) {
    assert.match(source, new RegExp(`export function ${name}\\b`))
  }
  assert.match(index, /export \{ Dialog, Drawer \} from '\.\/Overlay'/)
  assert.match(index, /export \{ SelectMenu \} from '\.\.\/SelectMenu'/)
  assert.match(index, /export \{ UiIcon \} from '\.\.\/UiIcon'/)
})

test('界面图标统一走 UiIcon，页面不保留字符占位或重复 SVG', () => {
  const webSource = fileURLToPath(new URL('../..', import.meta.url))
  const files = tsxFiles(webSource)
  const allowedSvgOwners = new Set(['UiIcon.tsx', 'ToolKindIcon.tsx'])
  for (const file of files) {
    const fileSource = readFileSync(file, 'utf8')
    assert.doesNotMatch(fileSource, /[×←→↑↓⌄⌕✓]/, `${file} 不得使用字符充当界面图标`)
    assert.doesNotMatch(fileSource, />\s*\+\s+[^<{]+</, `${file} 不得使用加号字符充当新增图标`)
    if (!allowedSvgOwners.has(file.split(/[\\/]/).at(-1)!)) assert.doesNotMatch(fileSource, /<svg\b/, `${file} 的通用图标应复用 UiIcon`)
    for (const match of fileSource.matchAll(/<UiIcon\b[^>]*\bsize=\{(\d+)\}/g)) {
      assert.ok(['12', '14', '16', '20'].includes(match[1]), `${file} 的 UiIcon 尺寸 ${match[1]} 不在统一档位内`)
    }
  }
  assert.doesNotMatch(`${piStartupCss}\n${taskViewCss}`, /content:\s*['"][^'"]*[›⌄×←→↑↓⌕✓][^'"]*['"]/, 'CSS 不得通过 content 注入字符图标')
})

test('shared controls keep frozen size, typography and semantic token contracts', () => {
  assert.match(css, /\.ui-icon-button \{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/)
  assert.match(css, /\.ui-icon-button\.is-small \{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/)
  assert.match(css, /\.ui-field \{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/)
  assert.match(css, /\.ui-status-badge \{[\s\S]*?font-size:\s*12px;/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(overlayCss, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(overlayCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('Dialog and Drawer own common accessibility behavior', () => {
  assert.match(overlay, /event\.key === 'Escape'/)
  assert.match(overlay, /event\.key !== 'Tab'/)
  assert.match(overlay, /aria-modal="true"/)
  assert.match(overlay, /previous\?\.focus/)
  assert.match(overlay, /export function Dialog/)
  assert.match(overlay, /export function Drawer/)
})

test('shared composites and Pi surfaces reuse UI primitives', () => {
  assert.match(composerPill, /import \{ SelectMenu, type SelectMenuOption \} from '\.\/ui'/)
  assert.match(stateViews, /import \{ Button \} from '\.\/ui'/)
  assert.match(piStartup, /import \{ Button \} from '\.\/ui'/)
  assert.match(piLivePage, /import \{ Button, IconButton, Input, Textarea \} from '\.\.\/components\/ui'/)
  assert.match(piLivePage, /<Textarea className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<Input className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<IconButton variant="primary" className="pi-live-send"/)
  for (const obsolete of [
    /\.pi-live-blocking button\s*\{/,
    /\.pi-live-startup-queue button\s*\{/,
    /\.pi-live-queue-item button\s*\{/,
    /\.pi-live-editor-toolbar button\s*\{/,
  ]) assert.doesNotMatch(piLiveCss, obsolete)
})

test('Workspace Shell owns three primary workspaces and one dynamic context host', () => {
  assert.match(workspaceSidebar, />任务中心</)
  assert.match(workspaceSidebar, />洞察</)
  assert.match(workspaceSidebar, />智能体</)
  assert.doesNotMatch(workspaceSidebar, />工具分析<\/NavLink>[\s\S]*workspace-primary-link/)
  assert.doesNotMatch(workspaceSidebar, />资产备份<\/NavLink>[\s\S]*workspace-primary-link/)
  assert.match(workspaceSidebar, /workspace-sidebar-context" ref=\{onContextHost\}/)
  assert.match(workspaceSidebar, /workspace-insight-navigation/)
  assert.match(workspaceSidebarCss, /grid-template-columns:\s*316px minmax\(0, 1fr\)/)
  assert.match(workspaceSidebarCss, /workspace-primary-link\.is-active/)
  assert.match(workspaceSidebarCss, /workspace-insight-filter-disclosure/)
  assert.match(app, /<ToolsPage model=\{model\} sidebarHost=\{sidebarHost\}/)
  assert.match(app, /<InsightsPage model=\{model\} sidebarHost=\{sidebarHost\}/)
})

test('Task Center context owns search, collapsed filters and task list', () => {
  assert.match(taskCenterPage, /createPortal\(taskRail, sidebarHost\)/)
  assert.match(taskCenterPage, /<Input className="task-center-search-input"/)
  assert.match(taskCenterPage, /<Disclosure className="task-center-filter-disclosure" summary="筛选"/)
  assert.match(taskCenterPage, /aria-label="任务列表：进行中 \+ 历史"/)
  assert.match(taskCenterPage, /task-center-new-task-button/)
  assert.doesNotMatch(taskCenterPage, /className="filter search-filter"/)
  assert.doesNotMatch(taskCenterPage, /<AgentScope\b/)
  assert.match(taskCenterCss, /\.task-center-search-input\.ui-field \{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/)
  assert.match(taskCenterCss, /\.task-center-filter-disclosure\[open\]/)
})

test('Tools and Insights own filters in the left context, never in a right-side toolbar', () => {
  assert.match(toolsPage, /import \{ Disclosure, Drawer, IconButton, SelectMenu, UiIcon \} from '\.\.\/components\/ui'/)
  assert.match(toolsPage, /createPortal\(sidebarFilters, sidebarHost\)/)
  assert.match(toolsPage, /workspace-insight-filter-disclosure/)
  assert.match(toolsPage, /summary="筛选"/)
  assert.doesNotMatch(toolsPage, /<Toolbar\b/)
  assert.doesNotMatch(toolsPage, /<AgentScope\b/)
  assert.match(toolsPage, /<Drawer[\s\S]*?className="tool-drill-overlay"/)
  assert.doesNotMatch(toolsPage, /tool-drawer-scrim|tool-drill-drawer|window\.addEventListener\('keydown'/)

  assert.match(insightsPage, /import \{ Disclosure, IconButton, SelectMenu, UiIcon \} from '\.\.\/components\/ui'/)
  assert.match(insightsPage, /createPortal\(sidebarFilters, sidebarHost\)/)
  assert.match(insightsPage, /workspace-insight-filter-disclosure/)
  assert.match(insightsPage, /summary="筛选"/)
  assert.doesNotMatch(insightsPage, /<Toolbar\b/)
  assert.doesNotMatch(insightsPage, /<AgentScope\b/)

  for (const pageCss of [toolsCss, insightsCss]) {
    assert.match(pageCss, /@media \(max-width: 991\.98px\)/)
    assert.match(pageCss, /@media \(max-width: 767\.98px\)/)
    assert.match(pageCss, /@media \(max-width: 575\.98px\)/)
  }
})

test('Review, Backup and Agent Overview retain their valid local primitives', () => {
  assert.match(reviewPage, /<Drawer[\s\S]*?className="review-inspector-overlay"/)
  assert.doesNotMatch(reviewPage, /document\.addEventListener\('keydown'/)
  assert.doesNotMatch(reviewCss, /@media \(max-width: (?:1180|900|640)px\)/)

  assert.match(backupPage, /import \{ Button, Dialog, Drawer, Toolbar \} from '\.\.\/components\/ui'/)
  assert.match(backupPage, /<Drawer[\s\S]*?className="backup-data-drawer"/)
  assert.match(backupPage, /<Dialog[\s\S]*?className="backup-confirm-overlay"/)
  assert.doesNotMatch(backupCss, /@media \(max-width: (?:1180|820|640)px\)/)

  assert.match(agentsPage, /import \{ IconButton, Toolbar, UiIcon \} from '\.\.\/components\/ui'/)
  assert.match(agentsPage, /<Toolbar className="workspace-toolbar" aria-label="智能体概览筛选">/)
  assert.doesNotMatch(agentsCss, /@media \(max-width: (?:820|760|560)px\)/)
  assert.match(agentsResponsiveCss, /@media \(max-width: 991\.98px\)[\s\S]*?\.agents-responsive-shell \.agent-source-nav/)
  assert.doesNotMatch(agentsCss, /#[0-9a-fA-F]{3,8}\b/)
})

test('repository rules keep shared UI and TaskSurface constraints explicit', () => {
  assert.match(agentRules, /UI \/ 组件契约（强制）/)
  assert.match(agentRules, /已有对应 Primitive 时，页面不得自行重新实现/)
  assert.match(agentRules, /TaskSurface/)
  assert.match(agentRules, /正常可见文字不得低于 `12px`/)
  assert.match(agentRules, /### 图标规范/)
})
