import { readFileSync } from 'node:fs'

const main = readFileSync('packages/web/src/main.tsx', 'utf8')
const page = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const tree = readFileSync('packages/web/src/components/BackupDirectoryTree.tsx', 'utf8')
const css = readFileSync('packages/web/src/backup-overlays.css', 'utf8')
const explainability = readFileSync('packages/backup-local/src/explainability.ts', 'utf8')
const localService = readFileSync('packages/backup-local/src/service.ts', 'utf8')
const swr = readFileSync('packages/backup-local/src/stale-while-revalidate.ts', 'utf8')
const plugin = readFileSync('packages/backup-local/src/plugin.ts', 'utf8')

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
if (!page.includes('<BackupDataRootTree')) {
  throw new Error('资产备份数据位置必须使用受控目录树展示')
}
if (!tree.includes('默认仅展开第 1 层') || !tree.includes('<details className="backup-tree-node">')) {
  throw new Error('备份目录树必须默认只展示第一层，并由用户逐级展开')
}

for (const required of [
  "[aria-label$='数据详情']",
  "[aria-label='恢复预演']",
  'position: fixed',
  'z-index: 130',
  'overscroll-behavior: contain',
  '.backup-confirm-scrim',
  '.backup-root-tree',
  '.backup-tree-node',
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

if (!explainability.includes('inventoryCache') || !explainability.includes('inventoryReadInFlight')) {
  throw new Error('资产备份解释层必须按索引 generation 复用 inventory，避免页面重复读盘和 JSON 解析')
}
if (!explainability.includes('appendDirectoryPath(root.tree, file)') || !explainability.includes('serializeDirectoryTree(root.tree)')) {
  throw new Error('资产备份目录统计必须单次归档文件并按 root 一次序列化')
}
if (explainability.includes('directoryTree(files, root.path)')) {
  throw new Error('资产备份不得恢复为每个 root 重扫整批 files 的目录树实现')
}

if (!plugin.includes('ctx.capturePolicy.settings.enabledSources') || !plugin.includes('sourceOrder')) {
  throw new Error('资产备份渐进扫描必须复用用户配置的智能体顺序，不得另造排序配置')
}
if (!swr.includes('for (const sourceId of this.sourceOrder)') || !swr.includes("{ sourceIds: [sourceId] }")) {
  throw new Error('资产备份后台刷新必须按配置顺序逐个 Source 扫描并逐步发布结果')
}
if (!localService.includes('this.plan(input)') || !localService.includes("filter(file => !selectedIds.has(file.sourceId))")) {
  throw new Error('资产备份局部刷新必须只扫描指定 Source，并合并保留其他 Source 的既有索引')
}
if (!page.includes('next.index?.refreshing !== true')) {
  throw new Error('渐进扫描未完成时不得提前把默认备份范围锁定为首个完成的智能体')
}

console.log('资产备份详情/恢复预演/目录树/解释层性能/渐进加载检查通过')
