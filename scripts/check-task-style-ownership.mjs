import { existsSync, readFileSync, readdirSync } from 'node:fs'

const webRoot = 'packages/web/src'
const mainPath = `${webRoot}/main.tsx`
const taskSurfacePath = `${webRoot}/features/TaskSurface.tsx`
const detailOwnerPath = `${webRoot}/task-detail.css`
const sessionOwnerPath = `${webRoot}/task-session-view.css`
const taskCenterPath = `${webRoot}/task-center.css`
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
const taskSurface = readFileSync(taskSurfacePath, 'utf8')
const imports = [...main.matchAll(/import\s+['\"](.+?\.css)['\"]/g)].map(match => match[1])
for (const required of ['./task-detail.css', './task-session-view.css']) {
  if (imports.filter(path => path === required).length !== 1) {
    throw new Error(`main.tsx 必须且只能加载一次 ${required}`)
  }
}
for (const retired of ['./task-detail-prototype.css', './task-detail-polish.css', './task-feedback-polish.css', './task-execution.css', './desktop-responsive.css']) {
  if (imports.includes(retired)) throw new Error(`main.tsx 不得加载已退役样式层：${retired}`)
}

for (const marker of [
  "const sessionReaderHooks = new Set(['review-reader-pane', 'pi-live-reader'])",
  "const sessionDocumentHooks = new Set(['review-reader', 'pi-live-document'])",
  "const sessionComposerHooks = new Set(['pi-live-compose-wrap'])",
  "withSessionClass(candidate, 'task-session-document')",
  "withSessionClass(element, 'task-session-reader'",
  "withSessionClass(candidate, 'task-session-composer')",
  'const sessionChildren = normalizeSessionChildren(children, sessionMode)',
  '>{sessionChildren}</section>',
]) {
  if (!taskSurface.includes(marker)) throw new Error(`TaskSurface 缺少统一 Session 槽位归一契约：${marker}`)
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
  '.task-session-view > .task-session-reader',
  '.task-session-view .task-session-document',
  '.task-session-view > .task-session-composer',
]) {
  if (!sessionOwner.includes(marker)) throw new Error(`task-session-view.css 缺少共享会话壳层契约：${marker}`)
}
for (const retiredSelector of ['.review-reader-pane', '.review-reader', '.pi-live-reader', '.pi-live-document', '.pi-live-compose-wrap']) {
  if (sessionOwner.includes(retiredSelector)) throw new Error(`task-session-view.css 不得再按页面私有类持有 Session 几何：${retiredSelector}`)
}

const taskCenter = readFileSync(taskCenterPath, 'utf8')
for (const marker of [
  '.task-center-main .review-reader',
  '.task-center-main .pi-live-document',
]) {
  if (taskCenter.includes(marker)) throw new Error(`task-center.css 不得重新接管 Session 阅读几何：${marker}`)
}

const componentSelector = /\.(?:task-round(?:\b|-)|task-message(?:\b|-)|task-thinking(?:\b|-)|task-tool(?:\b|-)|task-event(?:\b|-)|task-disclosure(?:\b|-))/g
const headerSelector = /\.task-header(?:\b|-)/g
const legacySessionGeometrySelector = /\.(?:review-reader-pane|review-reader|pi-live-reader|pi-live-document|pi-live-compose-wrap)(?![\w-])/g
const sharedSessionSlotSelector = /\.(?:task-session-reader|task-session-document|task-session-composer)(?![\w-])/g
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

  const legacySelectors = [...new Set(source.match(legacySessionGeometrySelector) ?? [])]
  if (legacySelectors.length) throw new Error(`${file} 不得再用页面私有 Reader / Composer 类定义 Session 几何：${legacySelectors.slice(0, 8).join(', ')}`)

  if (file !== 'task-session-view.css') {
    const sharedSlots = [...new Set(source.match(sharedSessionSlotSelector) ?? [])]
    if (sharedSlots.length) throw new Error(`${file} 越权定义统一 Session 槽位：${sharedSlots.slice(0, 8).join(', ')}`)
  }
}

for (const component of ['TaskHeader.tsx', 'TaskRound.tsx', 'TaskMessage.tsx', 'TaskThinking.tsx', 'TaskToolGroup.tsx', 'TaskToolRow.tsx', 'TaskEvent.tsx']) {
  const path = `${webRoot}/features/${component}`
  const source = readFileSync(path, 'utf8')
  if (/import\s+['\"][^'\"]+\.css['\"]/.test(source)) {
    throw new Error(`${component} 不得私有导入 CSS；组件表现统一由 task-detail.css 持有，会话几何统一由 task-session-view.css 持有`)
  }
}

console.log('Task 样式所有权检查通过：TaskSurface 统一 Session 槽位，组件与会话几何分层持有，页面私有 Reader / Composer 几何已退役。')
