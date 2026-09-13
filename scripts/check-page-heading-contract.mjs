import { readFileSync } from 'node:fs'

const compactHeading = readFileSync('packages/web/src/components/CompactPageHeading.tsx', 'utf8')
const backupPage = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')

if (!compactHeading.includes('return children ?? null')) {
  throw new Error('一级页面去重标题时必须继续允许 CompactPageHeading 渲染必要的辅助状态 children')
}
if (/<h[1-6]\b|className=["'](?:compact-)?page-heading/.test(compactHeading)) {
  throw new Error('CompactPageHeading 不得恢复一级页面重复标题容器')
}
if (/CompactPageHeading|page\.description|prototype-flag|page\.liveData/.test(backupPage)) {
  throw new Error('资产备份由面包屑表达当前位置，不得恢复重复标题、介绍段或孤立“本地真实数据”状态')
}

console.log('一级页面标题去重与资产备份去重复说明检查通过')
