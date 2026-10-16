import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('排序动作与拖拽只存在一份领域实现，三个入口复用', () => {
  const shared = read('./components/AgentOrderControls.tsx')
  const sources = [
    read('./components/AgentScope.tsx'),
    read('./components/SidebarFilterDisclosure.tsx'),
    read('./features/IntegrationManagementPage.tsx'),
  ]
  assert.match(shared, /export function useAgentOrderDrag/)
  assert.match(shared, /export function AgentOrderActions/)
  assert.match(shared, /canReorder\(id\)/)
  assert.match(shared, /move\(draggedId, id\)/)
  assert.match(shared, /moveBy\(sourceId, -1\)/)
  assert.match(shared, /moveBy\(sourceId, 1\)/)
  for (const source of sources) {
    assert.match(source, /useAgentOrderDrag\(\)/)
    assert.match(source, /<AgentOrderActions /)
    assert.doesNotMatch(source, /onDragStart=|onDragOver=|onDrop=|onDragEnd=/)
  }
})

test('智能体二级 URL 保持当前选中来源，不打断浏览器历史', () => {
  const app = read('./App.tsx')
  assert.match(app, /value: 'management',[\s\S]{0,220}encodeURIComponent\(resolvedAgentOverviewSourceId\)/)
  assert.match(app, /value: 'overview',[\s\S]{0,220}encodeURIComponent\(resolvedAgentOverviewSourceId\)/)
  assert.match(app, /<WorkspaceViewTabs/)
})

test('清除筛选使用统一 Button 而非页面级原生按钮', () => {
  const insights = read('./features/InsightsPage.tsx')
  const tools = read('./features/ToolsPage.tsx')
  const css = read('./components/workspace-sidebar.css')
  for (const source of [insights, tools]) {
    assert.match(source, /import \{ Button, /)
    assert.match(source, /<Button className="workspace-view-clear-filter"/)
    assert.doesNotMatch(source, /<button[^>]*className="workspace-view-clear-filter"/)
  }
  assert.match(css, /\.workspace-view-clear-filter\.btn \{/)
})

test('禁用关闭时 Escape 由共享 Overlay 层阻止，保留其他复用方的默认关闭行为', () => {
  const overlay = read('./components/ui/Overlay.tsx')
  assert.match(overlay, /closeDisabled = false/)
  assert.match(overlay, /closeDisabledRef\.current = closeDisabled/)
  assert.match(overlay, /if \(!closeDisabledRef\.current\) closeRef\.current\(\)/)
  assert.match(overlay, /useModalFocusScope\(\{ open, onClose, panelRef, closeDisabled \}\)/)
  assert.match(overlay, /if \(!closeDisabled && closeOnBackdrop/)
})

test('主视图从独立 Hook 引入快照，热点页面仅订阅必要领域', () => {
  const hook = read('./client/use-client-snapshot.ts')
  const app = read('./App.tsx')
  const tools = read('./features/ToolsPage.tsx')
  const insights = read('./features/InsightsPage.tsx')
  const task = read('./features/TaskCenterPage.tsx')
  assert.match(hook, /useCallback\(\(\) => model\.getSnapshot\(\)\[field\]/)
  assert.match(hook, /useSyncExternalStore\(model\.subscribe, read, read\)/)
  assert.match(app, /import \{ useClientSnapshot \} from '\.\/client\/use-client-snapshot'/)
  for (const source of [tools, insights, task]) {
    assert.match(source, /import \{ useClientSnapshotField \} from '\.\.\/client\/use-client-snapshot'/)
    assert.doesNotMatch(source, /from '\.\.\/App'/)
  }
  assert.match(task, /useClientSnapshotField\(model, 'review'\)/)
  assert.match(tools, /useClientSnapshotField\(model, 'usage'\)/)
  assert.match(insights, /useClientSnapshotField\(model, 'facets'\)/)
})
