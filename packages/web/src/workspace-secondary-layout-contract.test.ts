import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { orderAgentsByPreference, resolveAgentOverviewSource } from './components/agent-order'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('./components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const tabs = readFileSync(new URL('./components/WorkspaceViewTabs.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./components/workspace-sidebar.css', import.meta.url), 'utf8')
const shellCss = readFileSync(new URL('./shell.css', import.meta.url), 'utf8')
const agentLayoutCss = readFileSync(new URL('./agent-insights-responsive.css', import.meta.url), 'utf8')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const review = readFileSync(new URL('./features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const insights = readFileSync(new URL('./features/InsightsPage.tsx', import.meta.url), 'utf8')
const tools = readFileSync(new URL('./features/ToolsPage.tsx', import.meta.url), 'utf8')
const agents = readFileSync(new URL('./features/AgentsResponsivePage.tsx', import.meta.url), 'utf8')
const agentsPage = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const management = readFileSync(new URL('./features/IntegrationManagementPage.tsx', import.meta.url), 'utf8')
const backup = readFileSync(new URL('./features/BackupPage.tsx', import.meta.url), 'utf8')

test('non-task workspaces share 40px linked tabs, a stable toolbar and no duplicate title', () => {
  assert.match(app, /!hasWorkspaceTabs && <WorkspaceTopBar/)
  assert.match(app, /<WorkspaceTopBar/)
  assert.match(app, /<WorkspaceViewTabs/)
  assert.match(app, /className="workspace-view-toolbar"/)
  assert.match(css, /\.workspace-view-tabs\s*\{[\s\S]*?height:\s*40px;/)
  assert.doesNotMatch(css.match(/\.app-shell\s*\{([^}]*)\}/)?.[1] ?? '', /transition:\s*grid-template-columns/)
  assert.match(css, /\.workspace-view-toolbar\s*\{[\s\S]*?min-height:\s*48px;/)
  assert.match(tabs, /<Link/)
  assert.match(tabs, /aria-current=\{value === tab.value \? 'page'/)
  assert.match(tabs, /workspace-view-tab/)
})

test('non-task workspaces share the Task Center white surface and 1320px reading axis', () => {
  assert.match(css, /--al-workspace-content-max:\s*1320px;/)
  assert.match(css, /--al-workspace-content-inset:\s*28px;/)
  assert.match(css, /\.app-shell\.is-contextless-workspace \.app-main \{[\s\S]*?background:\s*var\(--al-surface\);/)
  assert.match(css, /\.app-main > \.workspace-page,[\s\S]*?\.app-main > \.agents-responsive-shell,[\s\S]*?background:\s*var\(--al-surface\);/)
  assert.match(css, /\.workspace-view-tabs\s*\{[\s\S]*?padding-inline:\s*max\(var\(--al-workspace-content-inset\)/)
  assert.match(css, /\.workspace-view-toolbar\s*\{[\s\S]*?padding-inline:\s*max\(var\(--al-workspace-content-inset\)/)
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 991\.98px\) \{[\s\S]*?--al-workspace-content-inset:\s*18px;/)
  assert.match(css, /@media \(max-width: 767\.98px\) \{[\s\S]*?--al-workspace-content-inset:\s*14px;/)
  assert.match(shellCss, /var\(--al-workspace-content-max, 1320px\)/)
  assert.match(agentLayoutCss, /\.agents-responsive-shell \{[\s\S]*?max-width:\s*var\(--al-workspace-content-max, 1320px\);/)
  assert.match(agentLayoutCss, /\.agent-insights-rail \{[\s\S]*?max-width:\s*var\(--al-workspace-content-max, 1320px\);/)
  assert.match(tokensCss, /--al-surface:#FFFFFF;/)
  assert.match(tokensCss, /:root\[data-theme='dark'\] \{[\s\S]*?--al-surface:#171A20;/)
})

test('agent overview follows the visible order, explicit URL and last manual selection', () => {
  const agents = [
    { sourceId: 'claude-code' },
    { sourceId: 'codex' },
    { sourceId: 'pi' },
  ]
  const visible = orderAgentsByPreference(agents, ['pi', 'codex'])
  const ids = visible.map(agent => agent.sourceId)
  assert.deepEqual(ids, ['pi', 'codex', 'claude-code'])
  assert.equal(resolveAgentOverviewSource(ids, '', ''), 'pi', 'first visible option is the default')
  assert.equal(resolveAgentOverviewSource(ids, '', 'codex'), 'codex', 'retain last manual selection')
  assert.equal(resolveAgentOverviewSource(ids, 'claude-code', 'codex'), 'claude-code', 'URL wins')
  assert.equal(resolveAgentOverviewSource(ids, 'removed-agent', ''), 'pi', 'stale URL falls back')
  assert.equal(resolveAgentOverviewSource(ids, 'removed-agent', 'codex'), 'codex')
  assert.equal(resolveAgentOverviewSource([], '', ''), '')
  assert.match(app, /const \{ ordered: integrationDisplayOrder \} = useIntegrationOrder\(\)/)
  assert.match(app, /orderAgentsByPreference\(agentSelectionItems, integrationDisplayOrder\)/)
  assert.match(app, /requestedAgentId = onAgents \? new URLSearchParams\(location\.search\)\.get\('agent'\)/)
  assert.match(app, /<IntegrationOrderProvider[\s\S]*?<Shell model=\{model\}\/?>/)
  assert.doesNotMatch(app, /const firstPresentIntegration =/)
  assert.doesNotMatch(app, /setAgentOverviewSourceId\(resolvedAgentOverviewSourceId\)/)
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
  assert.doesNotMatch(agents, /<WorkspaceViewTabs/)
  assert.match(agentsPage, /<WorkspaceViewTabs inline/)
  assert.match(agentsPage, /value: 'ecosystem'/)
  assert.doesNotMatch(management, /searchQuery/)
  assert.match(management, /className="workspace-view-controls"/)
  assert.match(management, /statusFilter/)
  assert.doesNotMatch(agents, /agent-view-switcher/)
})

test('backup history navigation is URL-based and actions stay in the business toolbar', () => {
  assert.match(app, /to: '\/backup\?view=history'/)
  assert.match(backup, /searchParams.get\('view'\) === 'history'/)
  assert.match(backup, /createPortal\(<div className="workspace-view-controls"/)
  assert.doesNotMatch(backup, /backup-view-switcher|backup-mobile-scope/)
})
