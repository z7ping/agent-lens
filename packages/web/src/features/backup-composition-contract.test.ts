import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const backupPage = readFileSync(new URL('./BackupPage.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../backup-responsive.css', import.meta.url), 'utf8')
const backupMainCss = readFileSync(new URL('../backup.css', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const sidebarFilter = readFileSync(new URL('../components/SidebarFilterDisclosure.tsx', import.meta.url), 'utf8')
const directoryTree = readFileSync(new URL('../components/BackupDirectoryTree.tsx', import.meta.url), 'utf8')

test('Backup 不重复渲染面包屑已经表达的页面标题', () => {
  assert.doesNotMatch(backupPage, /CompactPageHeading/)
  assert.doesNotMatch(backupPage, /page\.description/)
})

test('Backup 不保留 future / prototype 表现层命名', () => {
  assert.doesNotMatch(backupPage, /future-|prototype-/)
})

test('Backup 使用统一 workspace-page / page-content 壳层，而不是自定义 future 页面壳', () => {
  assert.match(backupPage, /className="workspace-page backup-page"/)
  assert.match(backupPage, /className="page-content backup-content"/)
  assert.doesNotMatch(backupPage, /future-content/)
  assert.doesNotMatch(backupPage, /page-scroll/)
  assert.match(backupPage, /sourceDot\(source\.sourceId\)/)
})

test('Backup 默认以当前资产为主视图，并把视图切换注入统一工作区顶栏', () => {
  assert.match(backupPage, /useState<'assets' \| 'history'>\('assets'\)/)
  assert.match(backupPage, /createPortal\(<div className="backup-topbar-controls"/)
  assert.match(backupPage, /<ToolbarGroup className="backup-view-switcher" role="group"/)
  assert.match(backupPage, /aria-pressed=\{activeView === 'assets'\}/)
  assert.match(backupPage, /scope-chip-active/)
  assert.match(backupPage, /t\('assetView\.currentTab'\)/)
  assert.match(backupPage, /t\('assetView\.historyTab'\)/)
  assert.match(backupPage, /activeView === 'assets'/)
  assert.doesNotMatch(backupPage, /className="future-kpis"/)
  assert.doesNotMatch(backupPage, /className="backup-restore-section"/)
})

test('当前资产使用单一 Surface + 聚焦总览 + 高密度资产表，避免空、散、无重点', () => {
  assert.match(backupPage, /className="backup-assets-surface"/)
  assert.match(backupPage, /className="backup-asset-overview"/)
  assert.match(backupPage, /className="backup-agent-table"/)
  assert.match(backupPage, /className="backup-agent-table-head"/)
  assert.match(backupMainCss, /\.backup-assets-surface \{[\s\S]*?background: var\(--al-surface\);/)
  assert.match(backupMainCss, /\.backup-asset-overview \{[\s\S]*?background: var\(--al-soft-2\);/)
  assert.match(backupMainCss, /\.backup-asset-overview-primary strong \{[\s\S]*?font-size: 22px;/)
  assert.doesNotMatch(backupPage, /className="backup-agent-card"/)
})

test('核心资产和历史状态使用稳定多行列表，不再挤成单行流式文本', () => {
  assert.match(backupMainCss, /\.backup-agent-cell \{[\s\S]*?display: grid;/)
  assert.match(backupMainCss, /\.backup-agent-cell-core \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  assert.match(backupMainCss, /\.backup-agent-cell-history \{[\s\S]*?grid-template-columns: 1fr;/)
  assert.match(backupMainCss, /\.backup-agent-cell > span \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.doesNotMatch(backupMainCss, /\.backup-agent-cell \{[\s\S]*?display: flex;/)
})

test('全部智能体使用固定列高密度资产表，并保留核心资产、历史状态和真实路径', () => {
  assert.match(backupPage, /className="backup-agent-table"/)
  assert.match(backupPage, /className="backup-agent-row"/)
  assert.match(backupPage, /className="backup-agent-cell backup-agent-cell-core"/)
  assert.match(backupPage, /className="backup-agent-row-path"/)
  assert.match(backupPage, /t\('assetView\.coreAssets'\)/)
  assert.match(backupPage, /t\('assetView\.historyStatus'\)/)
  assert.doesNotMatch(backupPage, /className="backup-agent-asset-summary"/)
  assert.doesNotMatch(backupPage, /className="backup-agent-asset-grid"/)
  assert.doesNotMatch(backupPage, /t\('assetView\.viewDetails'\)/)
})

test('单智能体由左侧筛选驱动，主区域直接展示完整资产详情', () => {
  assert.match(backupPage, /const focusedSource = selectedAssetSourceId/)
  assert.match(backupPage, /className="backup-agent-detail"/)
  assert.match(backupPage, /className="backup-asset-kind-list"/)
  assert.match(backupPage, /className="backup-asset-kind-header"/)
  assert.match(backupPage, /BackupDataRootTree/)
  assert.match(backupPage, /className="backup-age-facts"/)
})

test('资产范围复用工作区智能体筛选，并支持全部智能体单选入口', () => {
  assert.match(sidebar, /onBackup && <div className="workspace-context-menu workspace-agent-context">/)
  assert.match(sidebar, /showAllOption/)
  assert.match(sidebar, /navigation:backupScope/)
  assert.match(sidebar, /backupAssetSourceId/)
  assert.match(sidebarFilter, /showAllOption\?: boolean/)
  assert.match(sidebarFilter, /agentSelection\.mode === 'multiple' \|\| showAllOption/)
})

test('导入、创建与视图切换和面包屑共用一条 Workspace Topbar', () => {
  assert.match(app, /function WorkspaceTopBar/)
  assert.match(app, /className="workspace-topbar-page-tools"/)
  assert.match(app, /<BackupPage selectedAssetSourceId=\{backupAssetSourceId\} topbarHost=\{workspaceTopbarHost\} \/>/)
  assert.match(backupPage, /createPortal\(/)
  assert.match(backupPage, /<ToolbarGroup className="backup-toolbar-actions" align="end">/)
  assert.match(backupPage, /activeView === 'history'.*t\('snapshots\.verifyAll'\)/)
  assert.match(backupPage, /t\('toolbar\.import'\)/)
  assert.match(backupPage, /t\('toolbar\.create'\)/)
  assert.match(backupPage, /className="backup-create-drawer"/)
  assert.doesNotMatch(backupPage, /<Toolbar className="workspace-toolbar backup-toolbar"/)
  assert.doesNotMatch(backupPage, /className="backup-create-panel"/)
})

test('Backup 状态与目录类型统一复用 StatusBadge，不恢复页面私有 badge 方言', () => {
  assert.match(backupPage, /<StatusBadge/)
  assert.match(directoryTree, /<StatusBadge/)
  assert.doesNotMatch(backupPage, /className=(?:\{)?[`"']badge\b/)
  assert.doesNotMatch(directoryTree, /className=(?:\{)?[`"']badge\b/)
})

test('备份记录不使用含义重复的状态图标，也不显示解释性副文案', () => {
  assert.doesNotMatch(backupPage, /className="snapshot-icon"/)
  assert.doesNotMatch(backupPage, /assetView\.historyHint/)
  assert.doesNotMatch(backupPage, /assetView\.historyFilteredHint/)
  assert.doesNotMatch(backupPage, /description=\{t\('create\.description'\)\}/)
})

test('备份记录提供直达快照真实物理路径的检查入口', () => {
  assert.match(backupPage, /inspectPhysicalPaths\(snapshot\.id\)/)
  assert.match(backupPage, /api\.backupSnapshot\(id\)/)
  assert.match(backupPage, /className="backup-physical-path-drawer"/)
  assert.match(backupPage, /file\.originalPath/)
  assert.match(backupPage, /file\.sourceRelativePath/)
  assert.match(backupPage, /t\('snapshots\.physicalPaths'\)/)
  assert.match(backupPage, /t\('tree\.copyPath'\)/)
})

test('物理路径抽屉可以直接请求桌面宿主打开系统目录', () => {
  assert.match(backupPage, /api\.openHostDirectory\(path\)/)
  assert.match(backupPage, /t\('tree\.openDirectory'\)/)
  assert.match(backupPage, /className="backup-physical-path-actions"/)
})

test('备份记录保持连续表格信息结构，并在窄屏降级为纵向行', () => {
  assert.match(backupPage, /className="backup-snapshot-header"/)
  assert.match(backupPage, /snapshots\.columns\.snapshot/)
  assert.match(backupPage, /className="backup-snapshot-sources"/)
  assert.match(backupPage, /className="backup-snapshot-hash"/)
  assert.match(backupCss, /\.backup-snapshot-header \{[\s\S]*?display: none;/)
})

test('备份记录跟随左侧智能体范围过滤，并保留校验、预演和导出能力', () => {
  assert.match(backupPage, /const visibleSnapshots = selectedAssetSourceId/)
  assert.match(backupPage, /snapshot\.sourceIds\.includes\(selectedAssetSourceId\)/)
  assert.match(backupPage, /className="backup-history-section"/)
  assert.match(backupPage, /visibleSnapshots\.map/)
  assert.match(backupPage, /verifySnapshot/)
  assert.match(backupPage, /showRestorePreview/)
  assert.match(backupPage, /exportSnapshot/)
})

test('Backup 响应式不通过横向表格或滚动兜底核心资产信息', () => {
  assert.doesNotMatch(backupPage, /<table className="protection-table">/)
  assert.doesNotMatch(backupPage, /<table className="snapshot-table">/)
  assert.doesNotMatch(backupCss, /protection-table/)
  assert.doesNotMatch(backupCss, /snapshot-table/)
  assert.match(backupCss, /@media \(max-width: 575\.98px\)[\s\S]*?\.backup-agent-row \{[\s\S]*?grid-template-columns: 1fr;/)
  assert.match(backupCss, /\.backup-create-footer \{[\s\S]*?flex-direction: column;/)
})
