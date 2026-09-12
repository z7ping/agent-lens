import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const backupPage = readFileSync(new URL('./BackupPage.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../backup-responsive.css', import.meta.url), 'utf8')
const sidebar = readFileSync(new URL('../components/WorkspaceSidebar.tsx', import.meta.url), 'utf8')

test('Backup KPI 使用单一摘要条而不是四张悬浮卡', () => {
  assert.match(backupPage, /className="future-kpis"/)
  assert.match(backupPage, /t\('kpi\.detectedAgents'\)/)
  assert.match(backupPage, /t\('kpi\.backupData'\)/)
  assert.match(backupCss, /@media \(max-width: 1199\.98px\)[\s\S]*?\.future-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
})

test('Backup 主页面以快照管理为主，创建快照进入共享 Drawer', () => {
  assert.match(backupPage, /className="backup-snapshots-section"/)
  assert.match(backupPage, /className="backup-create-drawer"/)
  assert.match(backupPage, /setCreateOpen\(true\)/)
  assert.doesNotMatch(backupPage, /className="backup-workbench"/)
  assert.doesNotMatch(backupPage, /className="backup-create-panel"/)
  assert.doesNotMatch(backupPage, /<table className="protection-table">/)
  assert.doesNotMatch(backupPage, /<table className="snapshot-table">/)
})

test('无快照状态给出创建与导入两个明确动作', () => {
  assert.match(backupPage, /className="backup-empty-actions"/)
  assert.match(backupPage, /t\('snapshots\.createFirst'\)/)
  assert.match(backupPage, /importInput\.current\?\.click\(\)/)
})

test('智能体范围只在创建快照抽屉中选择，侧栏不再重复一套范围过滤', () => {
  assert.match(backupPage, /className="backup-source-list"/)
  assert.match(backupPage, /setDetailSourceId\(source\.sourceId\)/)
  assert.doesNotMatch(sidebar, /backupSourceIds/)
  assert.doesNotMatch(sidebar, /navigation:backupScope/)
})

test('Import / Restore 保持主列表之后的低频区，恢复能力没有删除', () => {
  const snapshotIndex = backupPage.indexOf('className="backup-snapshots-section"')
  const restoreIndex = backupPage.indexOf('className="backup-restore-section"')
  assert.ok(snapshotIndex >= 0 && restoreIndex > snapshotIndex)
  assert.match(backupPage, /restore\.selectPackage/)
  assert.match(backupPage, /showRestorePreview/)
  assert.match(backupPage, /exportSnapshot/)
  assert.match(backupPage, /BackupDataRootTree/)
})

test('Backup 响应式核心信息不通过横向滚动兜底', () => {
  assert.doesNotMatch(backupCss, /protection-table/)
  assert.doesNotMatch(backupCss, /snapshot-table/)
  assert.match(backupCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.backup-snapshot-row \{[\s\S]*?grid-template-columns: 1fr;/)
  assert.match(backupCss, /\.backup-create-footer \{[\s\S]*?flex-direction: column;/)
})
