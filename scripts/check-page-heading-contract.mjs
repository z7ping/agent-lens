import { readFileSync } from 'node:fs'

const compactHeading = readFileSync('packages/web/src/components/CompactPageHeading.tsx', 'utf8')
const backupPage = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')

if (!compactHeading.includes('return children ?? null')) {
  throw new Error('一级页面去重标题时必须继续渲染 CompactPageHeading 的辅助状态 children')
}
if (/<h[1-6]\b|className=["'](?:compact-)?page-heading/.test(compactHeading)) {
  throw new Error('CompactPageHeading 不得恢复一级页面重复标题容器')
}
if (!backupPage.includes('<span className="prototype-flag live">本地真实数据</span>')) {
  throw new Error('资产备份必须保留“本地真实数据”状态标识')
}

console.log('一级页面标题去重与辅助状态保留检查通过')
