import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const backupPage = readFileSync(new URL('./BackupPage.tsx', import.meta.url), 'utf8')
const backupCss = readFileSync(new URL('../backup-responsive.css', import.meta.url), 'utf8')

test('Backup KPI 使用单一摘要条而不是四张悬浮卡', () => {
  assert.match(backupCss, /\.backup-page \.future-kpis \{[\s\S]*?gap: 0;[\s\S]*?border: 1px solid var\(--al-line\);/)
  assert.match(backupCss, /\.backup-page \.future-kpi \{[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/)
})

test('Backup 保留连续 Protection 列表与 Snapshot 数据表', () => {
  assert.match(backupCss, /\.backup-page \.protection-grid \{[\s\S]*?gap: 0;[\s\S]*?border: 1px solid var\(--al-line\);/)
  assert.match(backupCss, /\.backup-page \.protection-card \{[\s\S]*?border: 0;[\s\S]*?border-bottom: 1px solid var\(--al-line\);/)
  assert.match(backupPage, /<table className="snapshot-table">/)
  assert.match(backupCss, /\.backup-page \.future-table-scroll \{[\s\S]*?border-top: 1px solid var\(--al-line\);[\s\S]*?border-bottom: 1px solid var\(--al-line\);/)
})

test('Import / Restore 收敛为同一 section 的流程行', () => {
  assert.match(backupCss, /\.backup-page \.restore-grid \{[\s\S]*?grid-template-columns: 1fr;[\s\S]*?gap: 0;/)
  assert.match(backupCss, /\.backup-page \.restore-card \{[\s\S]*?display: grid;[\s\S]*?border: 0;[\s\S]*?border-bottom: 1px solid var\(--al-line\);[\s\S]*?background: transparent;/)
})

test('Create Snapshot 只保留一个操作边界，内部改为 divider groups', () => {
  assert.match(backupCss, /\.future-grid > aside\.future-stack > \.future-card:first-child \{[\s\S]*?border-color: var\(--al-line-strong\);[\s\S]*?box-shadow: none;/)
  assert.match(backupCss, /\.backup-page \.builder-block \{[\s\S]*?border: 0;[\s\S]*?border-bottom: 1px solid var\(--al-line\);[\s\S]*?background: transparent;/)
  assert.match(backupCss, /\.backup-page \.builder-check \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/)
  assert.match(backupPage, /敏感信息保护强制开启/)
  assert.match(backupPage, /创建并校验快照/)
})

test('Backup Principles 是普通事实列表，成熟事实与恢复能力没有删除', () => {
  assert.match(backupCss, /\.backup-page \.backup-principles \{[\s\S]*?gap: 0;[\s\S]*?border-top: 1px solid var\(--al-line\);/)
  assert.match(backupCss, /\.backup-page \.backup-principles \.insight-item \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/)
  assert.match(backupPage, /BackupDataRootTree/)
  assert.match(backupPage, /verifySnapshot/)
  assert.match(backupPage, /showRestorePreview/)
  assert.match(backupPage, /exportSnapshot/)
})
