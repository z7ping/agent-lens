import { readFileSync } from 'node:fs'

const main = readFileSync('packages/web/src/main.tsx', 'utf8')
const page = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const css = readFileSync('packages/web/src/backup-overlays.css', 'utf8')

const backupImport = main.indexOf("import './backup.css'")
const overlayImport = main.indexOf("import './backup-overlays.css'")
const insightsImport = main.indexOf("import './insights.css'")
if (backupImport < 0 || overlayImport < 0 || insightsImport < 0 || !(backupImport < overlayImport && overlayImport < insightsImport)) {
  throw new Error('资产备份覆盖层样式必须紧随 backup.css 接入，并位于后续一级页面样式之前')
}

if (!page.includes('onClick={() => setDetailSourceId(source.sourceId)}>数据详情</button>')) {
  throw new Error('资产备份必须保留“数据详情”点击状态入口')
}
if (!page.includes("aria-label={`${sourceLabel(detailSource.sourceId, detailSource.displayName)} 数据详情`}")) {
  throw new Error('数据详情抽屉必须保留可识别的无障碍名称')
}
if (!page.includes('aria-label="恢复预演"')) {
  throw new Error('恢复预演抽屉必须保留独立无障碍名称')
}
if (!page.includes('backup-confirm-scrim')) {
  throw new Error('关键操作确认必须保留独立遮罩标识')
}

for (const required of [
  "[aria-label$='数据详情']",
  "[aria-label='恢复预演']",
  'position: fixed',
  'z-index: 130',
  'overscroll-behavior: contain',
  '.backup-confirm-scrim',
  '@media (max-width: 640px)',
]) {
  if (!css.includes(required)) throw new Error(`资产备份覆盖层缺少正式交互约束：${required}`)
}

if (!css.includes(":has(+ .drawer.show[aria-label$='数据详情'])") || !css.includes(":has(+ .drawer.show[aria-label='恢复预演'])")) {
  throw new Error('数据详情和恢复预演必须拥有可点击关闭的固定遮罩层')
}

if (/!important\b/.test(css)) {
  throw new Error('资产备份覆盖层不得依赖 !important 争夺优先级')
}

const fontSizes = [...css.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)].map(match => Number(match[1]))
const tooSmall = fontSizes.filter(value => value > 0 && value < 12)
if (tooSmall.length) {
  throw new Error(`资产备份覆盖层出现小于 12px 的字号：${[...new Set(tooSmall)].join(', ')}px`)
}

console.log('资产备份详情/恢复预演覆盖层检查通过')
