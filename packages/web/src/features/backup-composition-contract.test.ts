import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const backupPage = readFileSync(new URL('./BackupPage.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../backup-responsive.css', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const sidebarFilter = readFileSync(new URL('../components/SidebarFilterDisclosure.tsx', import.meta.url), 'utf8')

test('Backup 主页面以当前资产为核心，不再以 KPI 或快照操作占据首屏', () => {
  assert.match(backupPage, /className="backup-overview-strip"/)
  assert.match(backupPage, /className="backup-assets-section"/)
  assert.match(backupPage, /t\('assetView\.currentAssets'\)/)
  assert.doesNotMatch(backupPage, /className="future-kpis"/)
  assert.doesNotMatch(backupPage, /className="backup-restore-section"/)
})

test('全部智能体按智能体分段展示资产摘要，单智能体升级为主页面详情', () => {
  assert.match(backupPage, /className="backup-agent-asset-summary"/)
  assert.match(backupPage, /className="backup-agent-kind-facts"/)
  assert.match(backupPage, /className="backup-agent-detail"/)
  assert.match(backupPage, /className="backup-asset-kind-list"/)
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

test('导入与创建只保留为右上角动作，创建流程进入共享 Drawer', () => {
  const headingIndex = backupPage.indexOf('className="backup-heading-actions"')
  const assetsIndex = backupPage.indexOf('className="backup-assets-section"')
  assert.ok(headingIndex >= 0 && headingIndex < assetsIndex)
  assert.match(backupPage, /t\('toolbar\.import'\)/)
  assert.match(backupPage, /t\('toolbar\.create'\)/)
  assert.match(backupPage, /className="backup-create-drawer"/)
  assert.doesNotMatch(backupPage, /className="backup-create-panel"/)
})

test('备份记录位于当前资产之后，并继续保留校验、预演和导出能力', () => {
  const assetsIndex = backupPage.indexOf('className="backup-assets-section"')
  const historyIndex = backupPage.indexOf('className="backup-history-section"')
  assert.ok(assetsIndex >= 0 && historyIndex > assetsIndex)
  assert.match(backupPage, /verifySnapshot/)
  assert.match(backupPage, /showRestorePreview/)
  assert.match(backupPage, /exportSnapshot/)
})

test('Backup 响应式不通过横向表格或滚动兜底核心资产信息', () => {
  assert.doesNotMatch(backupPage, /<table className="protection-table">/)
  assert.doesNotMatch(backupPage, /<table className="snapshot-table">/)
  assert.doesNotMatch(backupCss, /protection-table/)
  assert.doesNotMatch(backupCss, /snapshot-table/)
  assert.match(backupCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.backup-asset-kind-row \{[\s\S]*?grid-template-columns: 1fr auto;/)
  assert.match(backupCss, /\.backup-create-footer \{[\s\S]*?flex-direction: column;/)
})
