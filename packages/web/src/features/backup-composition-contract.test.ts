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

test('Backup 主区是快照列表加新建快照工作台，不再依赖横向表格', () => {
  assert.match(backupPage, /className="backup-workbench"/)
  assert.match(backupPage, /className="backup-snapshot-list"/)
  assert.match(backupPage, /className="future-card backup-create-panel"/)
  assert.doesNotMatch(backupPage, /<table className="protection-table">/)
  assert.doesNotMatch(backupPage, /<table className="snapshot-table">/)
  assert.match(backupCss, /\.backup-workbench \{ grid-template-columns: 1fr; \}/)
})

test('智能体范围只在新建快照面板选择，侧栏不再重复一套范围过滤', () => {
  assert.match(backupPage, /className="backup-source-list"/)
  assert.match(backupPage, /setDetailSourceId\(source\.sourceId\)/)
  assert.doesNotMatch(sidebar, /backupSourceIds/)
  assert.doesNotMatch(sidebar, /navigation:backupScope/)
})

test('Import / Restore 下沉为工作台之后的低频区，但恢复能力没有删除', () => {
  const workbenchIndex = backupPage.indexOf('className="backup-workbench"')
  const restoreIndex = backupPage.indexOf('className="backup-restore-section"')
  assert.ok(workbenchIndex >= 0 && restoreIndex > workbenchIndex)
  assert.match(backupPage, /restore\.selectPackage/)
  assert.match(backupPage, /showRestorePreview/)
  assert.match(backupPage, /exportSnapshot/)
  assert.match(backupPage, /BackupDataRootTree/)
})

test('Backup 响应式核心信息不通过横向滚动兜底', () => {
  assert.doesNotMatch(backupCss, /protection-table/)
  assert.doesNotMatch(backupCss, /snapshot-table/)
  assert.match(backupCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.backup-snapshot-row \{[\s\S]*?grid-template-columns: 1fr;/)
})
