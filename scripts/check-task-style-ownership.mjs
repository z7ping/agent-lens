import { existsSync, readFileSync, readdirSync } from 'node:fs'

const webRoot = 'packages/web/src'
const mainPath = `${webRoot}/main.tsx`
const canonicalPath = `${webRoot}/task-detail.css`
const retiredPaths = [
  `${webRoot}/task-detail-prototype.css`,
  `${webRoot}/task-detail-polish.css`,
  `${webRoot}/task-feedback-polish.css`,
  `${webRoot}/task-execution.css`,
  `${webRoot}/desktop-responsive.css`,
  `${webRoot}/features/task-header.css`,
]

for (const path of retiredPaths) {
  if (existsSync(path)) throw new Error(`已退役的 Task / Desktop 覆盖层不应重新出现：${path}`)
}
if (!existsSync(canonicalPath)) throw new Error(`Task Surface 缺少共享样式所有者：${canonicalPath}`)

const main = readFileSync(mainPath, 'utf8')
const imports = [...main.matchAll(/import\s+['\"](.+?\.css)['\"]/g)].map(match => match[1])
if (imports.filter(path => path === './task-detail.css').length !== 1) {
  throw new Error('main.tsx 必须且只能加载一次 ./task-detail.css')
}
for (const retired of ['./task-detail-prototype.css', './task-detail-polish.css', './task-feedback-polish.css', './task-execution.css', './desktop-responsive.css']) {
  if (imports.includes(retired)) throw new Error(`main.tsx 不得加载已退役样式层：${retired}`)
}

const canonical = readFileSync(canonicalPath, 'utf8')
for (const marker of [
  'Task Surface 共享详情组件的唯一样式所有者',
  '.task-surface .task-header',
  '.task-surface .task-round',
  '.task-surface .task-message-row',
  '.task-surface .task-thinking',
  '.task-surface .task-tool-row',
  '.task-surface .task-event-row',
]) {
  if (!canonical.includes(marker)) throw new Error(`task-detail.css 缺少共享表现契约：${marker}`)
}

const sharedSelector = /\.(?:task-header(?:\b|-)|task-round(?:\b|-)|task-message(?:\b|-)|task-thinking(?:\b|-)|task-tool(?:\b|-)|task-event(?:\b|-)|task-disclosure(?:\b|-))/g
const allowedOwner = 'task-detail.css'
const cssFiles = readdirSync(webRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.css'))
  .map(entry => entry.name)
for (const file of cssFiles) {
  if (file === allowedOwner) continue
  const source = readFileSync(`${webRoot}/${file}`, 'utf8')
  const selectors = [...new Set(source.match(sharedSelector) ?? [])]
  if (selectors.length) throw new Error(`${file} 越权定义 Task Surface 共享选择器：${selectors.slice(0, 8).join(', ')}`)
}

for (const component of ['TaskHeader.tsx', 'TaskRound.tsx', 'TaskMessage.tsx', 'TaskThinking.tsx', 'TaskToolGroup.tsx', 'TaskToolRow.tsx', 'TaskEvent.tsx']) {
  const path = `${webRoot}/features/${component}`
  const source = readFileSync(path, 'utf8')
  if (/import\s+['\"][^'\"]+\.css['\"]/.test(source)) {
    throw new Error(`${component} 不得私有导入 CSS；共享表现统一由 task-detail.css 持有`)
  }
}

console.log('Task Surface 样式所有权检查通过：共享组件单一所有者，旧覆盖层与跨页面越权规则均已退役。')
