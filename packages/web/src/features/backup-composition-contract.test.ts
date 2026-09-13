import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const backupPage = readFileSync(new URL('./BackupPage.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../backup-responsive.css', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const sidebarFilter = readFileSync(new URL('../components/SidebarFilterDisclosure.tsx', import.meta.url), 'utf8')

test('Backup 不重复渲染面包屑已经表达的页面标题', () => {
  assert.doesNotMatch(backupPage, /CompactPageHeading/)
  assert.doesNotMatch(backupPage, /page\.description/)
})

test('Backup 使用统一 workspace-page / page-content 壳层，而不是自定义 future 页面壳', () => {
  assert.match(backupPage, /className="workspace-page backup-page"/)
  assert.match(backupPage, /className="page-content backup-content"/)
  assert.doesNotMatch(backupPage, /future-content/)
  assert.doesNotMatch(backupPage, /page-scroll/)
  assert.match(backupPage, /sourceDot\(source\.sourceId\)/)
})

test('Backup 默认以当前资产为主视图，并把备份记录拆成独立页签', () => {
  assert.match(backupPage, /useState<'assets' \| 'history'>\('assets'\)/)
  assert.match(backupPage, /className="backup-view-tabs"/)
  assert.match(backupPage, /t\('assetView\.currentTab'\)/)
  assert.match(backupPage, /t\('assetView\.historyTab'\)/)
  assert.match(backupPage, /activeView === 'assets'/)
  assert.doesNotMatch(backupPage, /className="future-kpis"/)
  assert.doesNotMatch(backupPage, /className="backup-restore-section"/)
})

test('全部智能体使用单一扁平列表，并保留核心资产、历史状态和真实路径', () => {
  assert.match(backupPage, /className="backup-agent-row"/)
  assert.match(backupPage, /className="backup-agent-row-body"/)
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

test('导入与创建进入统一面包屑操作区，创建流程继续复用共享 Drawer', () => {
  assert.match(app, /setBackupBreadcrumbActionsHost/)
  assert.match(app, /<BackupPage selectedAssetSourceId=\{backupAssetSourceId\} actionsHost=\{backupBreadcrumbActionsHost\}/)
  assert.match(backupPage, /createPortal\(headerActions, actionsHost\)/)
  assert.match(backupPage, /className="backup-breadcrumb-actions"/)
  assert.match(backupPage, /t\('toolbar\.import'\)/)
  assert.match(backupPage, /t\('toolbar\.create'\)/)
  assert.match(backupPage, /className="backup-create-drawer"/)
  assert.doesNotMatch(backupPage, /className="backup-create-panel"/)
  assert.doesNotMatch(backupPage, /className="future-heading"/)
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
  assert.match(backupCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.backup-agent-row \{[\s\S]*?grid-template-columns: 1fr;/)
  assert.match(backupCss, /\.backup-create-footer \{[\s\S]*?flex-direction: column;/)
})
