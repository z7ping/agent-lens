import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('./components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const tabs = readFileSync(new URL('./components/WorkspaceViewTabs.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./components/workspace-sidebar.css', import.meta.url), 'utf8')
const review = readFileSync(new URL('./features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const insights = readFileSync(new URL('./features/InsightsPage.tsx', import.meta.url), 'utf8')
const tools = readFileSync(new URL('./features/ToolsPage.tsx', import.meta.url), 'utf8')
const agents = readFileSync(new URL('./features/AgentsResponsivePage.tsx', import.meta.url), 'utf8')
const management = readFileSync(new URL('./features/IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const backup = readFileSync(new URL('./features/BackupPage.tsx', import.meta.url), 'utf8')

test('four workspaces share a 50px title, 40px linked tabs and an independent business toolbar', () => {
  assert.match(app, /<WorkspaceTopBar/)
  assert.match(app, /<WorkspaceViewTabs/)
  assert.match(app, /className="workspace-view-toolbar"/)
  assert.match(css, /\.workspace-view-tabs\s*\{[\s\S]*?height:\s*40px;/)
  assert.match(css, /\.workspace-view-toolbar\s*\{[\s\S]*?min-height:\s*48px;/)
  assert.match(tabs, /<Link/)
  assert.match(tabs, /aria-current=\{value === tab.value \? 'page'/)
  assert.match(tabs, /workspace-view-tab/)
})

test('task center preserves its original independently scrolling session rail', () => {
  assert.match(app, /<TaskCenterPage model=\{model\} mode="history" sidebarHost=\{sidebarHost\}/)
  assert.match(review, /createPortal\(taskRail, sidebarHost\)/)
})

test('insights and tools use the same multiselect/project/time filter layout without a second left rail', () => {
  for (const page of [insights, tools]) {
    assert.match(page, /toolbarHost \? createPortal\(toolbarFilters, toolbarHost\)/)
    assert.match(page, /<SidebarFilterDisclosure/)
    assert.match(page, /<SelectMenu/)
    assert.doesNotMatch(page, /sidebarHost/)
  }
  assert.doesNotMatch(sidebar, /workspace-insight-switcher/)
  assert.match(app, /hasWorkspaceTabs \? 'is-contextless-workspace'/)
})

test('agents have only overview and management as global views; Pi discovery is nested', () => {
  assert.match(app, /value: 'management', label: t\('navigation:integrationManagement'\)/)
  assert.match(agents, /<WorkspaceViewTabs\s+nested/)
  assert.match(agents, /value: 'ecosystem'/)
  assert.match(management, /searchQuery/)
  assert.match(management, /statusFilter/)
  assert.doesNotMatch(agents, /agent-view-switcher/)
})

test('backup history navigation is URL-based and actions stay in the business toolbar', () => {
  assert.match(app, /to: '\/backup\?view=history'/)
  assert.match(backup, /searchParams.get\('view'\) === 'history'/)
  assert.match(backup, /createPortal\(<div className="backup-toolbar-controls"/)
  assert.doesNotMatch(backup, /backup-view-switcher|backup-mobile-scope/)
})
