import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const navigation = readFileSync(new URL('./components/WorkspacePrimaryNavigation.tsx', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('./components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const sidebarCss = readFileSync(new URL('./components/workspace-sidebar.css', import.meta.url), 'utf8')
const workspace = readFileSync(new URL('./features/AgentsResponsivePage.tsx', import.meta.url), 'utf8')
const agentsPage = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const icon = readFileSync(new URL('./components/UiIcon.tsx', import.meta.url), 'utf8')

test('only four primary entries; backup is separate while integration belongs to agents', () => {
  assert.match(navigation, /id: 'agents', to: '\/agents'/)
  assert.match(navigation, /id: 'backup', to: '\/backup'/)
  assert.doesNotMatch(navigation, /id: 'integrations'/)
  assert.match(icon, /agent: Bot/)
  assert.match(icon, /backup: ArchiveRestore/)
  assert.doesNotMatch(sidebar, /workspace-settings-management-title/)
  assert.doesNotMatch(sidebar, /navigate\('\/integrations'\)/)
})

test('analytics, agents and backup retain only the 40px navigation rail on desktop and a drawer on mobile', () => {
  assert.match(app, /hasWorkspaceTabs \\? 'is-contextless-workspace'/)
  assert.match(sidebarCss, /\.app-shell\.is-contextless-workspace\s*\{\s*grid-template-columns:\s*40px minmax\(0, 1fr\);/)
  assert.match(sidebarCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.app-shell\.is-contextless-workspace\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/)
})

test('the agent workspace keeps stable global tabs and shares a selector for overview/Pi views', () => {
  assert.match(workspace, /<SelectMenu\s+value=\{sourceId\}/)
  assert.match(workspace, /activeView === 'management'/)
  assert.match(workspace, /<IntegrationManagementPage/)
  assert.match(workspace, /<WorkspaceViewTabs/)
  assert.match(workspace, /<AgentsPage/)
  assert.match(agentsPage, /navigate\(`\/agents\?view=management&agent=/)
})

test('legacy integration links retain query targets and redirect to the merged workspace', () => {
  assert.match(app, /function LegacyIntegrationRedirect\(/)
  assert.match(app, /params\.set\('view', 'management'\)/)
  assert.match(app, /<Route path="\/integrations" element=\{<LegacyIntegrationRedirect\/>\}/)
  assert.match(app, /new URLSearchParams\(location\.search\)\.get\('agent'\)/)
})
