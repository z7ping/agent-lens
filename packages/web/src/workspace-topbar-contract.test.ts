import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const shellResponsive = readFileSync(new URL('./shell-responsive.css', import.meta.url), 'utf8')
const workspaceCss = readFileSync(new URL('./components/workspace-sidebar.css', import.meta.url), 'utf8')
const backup = readFileSync(new URL('./features/BackupPage.tsx', import.meta.url), 'utf8')
const agents = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const tools = readFileSync(new URL('./features/ToolsPage.tsx', import.meta.url), 'utf8')
const insights = readFileSync(new URL('./features/InsightsPage.tsx', import.meta.url), 'utf8')

test('一级工作区统一使用单行 Workspace Topbar', () => {
  assert.match(app, /function WorkspaceTopBar/)
  assert.match(app, /className=\{\`workspace-topbar/)
  assert.match(app, /className="workspace-topbar-page-tools"/)
  assert.doesNotMatch(app, /workspace-breadcrumb-shell/)
  assert.doesNotMatch(app, /WorkspaceBreadcrumb/)
  assert.match(workspaceCss, /\.workspace-topbar \{[\s\S]*?height: 50px;[\s\S]*?min-height: 50px;/)
})

test('面包屑只作为 Topbar 左侧内容，不再拥有独立行高和边框', () => {
  assert.match(workspaceCss, /\.workspace-breadcrumb \{[\s\S]*?flex: 0 1 auto;/)
  assert.doesNotMatch(workspaceCss, /\.workspace-breadcrumb \{[\s\S]*?flex: 0 0 38px;/)
  assert.doesNotMatch(workspaceCss, /\.workspace-breadcrumb \{[\s\S]*?border-bottom:/)
})

test('Backup 视图切换和一级操作注入 Topbar，不恢复第二条 Toolbar', () => {
  assert.match(app, /topbarHost=\{workspaceTopbarHost\}/)
  assert.match(backup, /createPortal\(<div className="backup-topbar-controls"/)
  assert.match(backup, /<ToolbarGroup className="backup-view-switcher"/)
  assert.match(backup, /<ToolbarGroup className="backup-toolbar-actions"/)
  assert.doesNotMatch(backup, /<Toolbar className="workspace-toolbar/)
})

test('Agents / Tools / Insights 不在统一 Topbar 下新增第二条一级工具栏', () => {
  assert.doesNotMatch(tools, /<Toolbar className="workspace-toolbar/)
  assert.doesNotMatch(insights, /<Toolbar className="workspace-toolbar/)
  assert.doesNotMatch(agents, /workspace-toolbar/)
})

test('窄屏保持单行优先，只压缩低优先级面包屑层级', () => {
  assert.match(shellResponsive, /@media \(max-width: 575\.98px\)[\s\S]*?\.workspace-topbar \.workspace-breadcrumb li:not\(:last-child\)/)
})
