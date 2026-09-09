import { existsSync, readFileSync, readdirSync } from 'node:fs'

const webRoot = 'packages/web/src'
const mainPath = `${webRoot}/main.tsx`
const detailOwnerPath = `${webRoot}/task-detail.css`
const sessionOwnerPath = `${webRoot}/task-session-view.css`
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
if (!existsSync(detailOwnerPath)) throw new Error(`Task Surface 缺少共享组件样式所有者：${detailOwnerPath}`)
if (!existsSync(sessionOwnerPath)) throw new Error(`Task Session 缺少共享会话壳层样式所有者：${sessionOwnerPath}`)

const main = readFileSync(mainPath, 'utf8')
const imports = [...main.matchAll(/import\s+['\"](.+?\.css)['\"]/g)].map(match => match[1])
for (const required of ['./task-detail.css', './task-session-view.css']) {
  if (imports.filter(path => path === required).length !== 1) {
    throw new Error(`main.tsx 必须且只能加载一次 ${required}`)
  }
}
for (const retired of ['./task-detail-prototype.css', './task-detail-polish.css', './task-feedback-polish.css', './task-execution.css', './desktop-responsive.css']) {
  if (imports.includes(retired)) throw new Error(`main.tsx 不得加载已退役样式层：${retired}`)
}

const detailOwner = readFileSync(detailOwnerPath, 'utf8')
for (const marker of [
  'Task Surface 共享详情组件的唯一样式所有者',
  '.task-surface .task-header',
  '.task-surface .task-round',
  '.task-surface .task-message-row',
  '.task-surface .task-thinking',
  '.task-surface .task-tool-row',
  '.task-surface .task-event-row',
]) {
  if (!detailOwner.includes(marker)) throw new Error(`task-detail.css 缺少共享表现契约：${marker}`)
}

const sessionOwner = readFileSync(sessionOwnerPath, 'utf8')
for (const marker of [
  'Review / Pi Live 共用会话视图的唯一样式所有者',
  '.task-session-view',
  '.task-surface-review .review-reader-pane',
  '.task-surface-live .pi-live-compose-wrap',
]) {
  if (!sessionOwner.includes(marker)) throw new Error(`task-session-view.css 缺少共享会话壳层契约：${marker}`)
}

const componentSelector = /\.(?:task-round(?:\b|-)|task-message(?:\b|-)|task-thinking(?:\b|-)|task-tool(?:\b|-)|task-event(?:\b|-)|task-disclosure(?:\b|-))/g
const headerSelector = /\.task-header(?:\b|-)/g
const cssFiles = readdirSync(webRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.css'))
  .map(entry => entry.name)

for (const file of cssFiles) {
  const source = readFileSync(`${webRoot}/${file}`, 'utf8')

  if (file !== 'task-detail.css') {
    const selectors = [...new Set(source.match(componentSelector) ?? [])]
    if (selectors.length) throw new Error(`${file} 越权定义 Task Surface 共享组件选择器：${selectors.slice(0, 8).join(', ')}`)
  }

  if (file !== 'task-detail.css' && file !== 'task-session-view.css') {
    const selectors = [...new Set(source.match(headerSelector) ?? [])]
    if (selectors.length) throw new Error(`${file} 越权定义 TaskHeader 共享选择器：${selectors.slice(0, 8).join(', ')}`)
  }
}

for (const component of ['TaskHeader.tsx', 'TaskRound.tsx', 'TaskMessage.tsx', 'TaskThinking.tsx', 'TaskToolGroup.tsx', 'TaskToolRow.tsx', 'TaskEvent.tsx']) {
  const path = `${webRoot}/features/${component}`
  const source = readFileSync(path, 'utf8')
  if (/import\s+['\"][^'\"]+\.css['\"]/.test(source)) {
    throw new Error(`${component} 不得私有导入 CSS；组件表现统一由 task-detail.css 持有，会话几何统一由 task-session-view.css 持有`)
  }
}

console.log('Task 样式所有权检查通过：共享组件与 Session 几何分层持有，旧覆盖层与跨页面越权规则均已退役。')
