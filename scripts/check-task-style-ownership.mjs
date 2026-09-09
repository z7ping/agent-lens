import { existsSync, readFileSync, readdirSync } from 'node:fs'

const webRoot = 'packages/web/src'
const mainPath = `${webRoot}/main.tsx`
const tokensPath = `${webRoot}/tokens.css`
const taskSurfacePath = `${webRoot}/features/TaskSurface.tsx`
const reviewPagePath = `${webRoot}/features/ReviewPage.tsx`
const taskRoundPath = `${webRoot}/features/TaskRound.tsx`
const virtualRoundPath = `${webRoot}/components/VirtualRoundMount.tsx`
const taskDetailModelPath = `${webRoot}/features/task-detail-model.ts`
const detailOwnerPath = `${webRoot}/task-detail.css`
const sessionOwnerPath = `${webRoot}/task-session-view.css`
const turnRailOwnerPath = `${webRoot}/task-turn-rail.css`
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
if (!existsSync(turnRailOwnerPath)) throw new Error(`Task Surface 缺少共享轮次导轨样式所有者：${turnRailOwnerPath}`)

const main = readFileSync(mainPath, 'utf8')
const tokens = readFileSync(tokensPath, 'utf8')
const taskSurface = readFileSync(taskSurfacePath, 'utf8')
const reviewPage = readFileSync(reviewPagePath, 'utf8')
const taskRound = readFileSync(taskRoundPath, 'utf8')
const virtualRound = readFileSync(virtualRoundPath, 'utf8')
const taskDetailModel = readFileSync(taskDetailModelPath, 'utf8')
const imports = [...main.matchAll(/import\s+['\"](.+?\.css)['\"]/g)].map(match => match[1])
for (const required of ['./task-detail.css', './task-session-view.css', './task-turn-rail.css']) {
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

for (const marker of [
  'semanticId?: string',
  'data-round-semantic-id={model.semanticId ?? model.id}',
  'data-round-semantic-id={stableSemanticId || undefined}',
  'const bySemanticId = new Map<string, TaskTurnRailItem>()',
  'const semanticId = element.dataset.roundSemanticId?.trim()',
  'semanticId: string',
  'function stabilizeTurnRailItemIds(',
  'const next = stabilizeTurnRailItemIds(railItemsRef.current, collected)',
  'const railFrame = sessionMode ? sessionRailFrame(root, viewportRect) : viewportRect',
]) {
  if (![taskDetailModel, taskRound, virtualRound, taskSurface].some(source => source.includes(marker))) {
    throw new Error(`Turn Rail 缺少统一语义/几何/稳定身份契约：${marker}`)
  }
}

for (const marker of [
  "cssPixelValue(root, '--al-task-turn-rail-bottom-reserve')",
  "child.classList.contains('task-session-composer')",
  'const reserve = Math.max(baselineReserve, composerRect?.height ?? 0)',
  'const bottom = Math.max(top, surface.bottom - reserve)',
]) {
  if (!taskSurface.includes(marker)) throw new Error(`Turn Rail 缺少 Pi Live 基准的共享 Rail Frame 契约：${marker}`)
}
if (!tokens.includes('--al-task-turn-rail-bottom-reserve:145px;')) {
  throw new Error('tokens.css 必须定义统一 Turn Rail 底部安全区，保持 Review 与 Pi Live 默认视觉尺度一致')
}

for (const marker of [
  'export interface TaskBoundaryNavigation',
  'boundaryNavigation?: TaskBoundaryNavigation',
  'function sessionBoundaryPosition(',
  'const resolvedBoundaryNavigation: TaskBoundaryNavigation | undefined',
  'className="task-boundary-nav"',
  'aria-label="会话边界导航"',
  'onClick={() => void resolvedBoundaryNavigation.onStart()}',
  'onClick={() => void resolvedBoundaryNavigation.onEnd()}',
]) {
  if (!taskSurface.includes(marker)) throw new Error(`TaskSurface 缺少统一会话边界导航契约：${marker}`)
}
for (const marker of [
  'boundaryNavigation={detail ? {',
  'onStart: showFromStart',
  'onEnd: jumpToLatest',
]) {
  if (!reviewPage.includes(marker)) throw new Error(`Review 必须只向 TaskSurface 提供边界导航行为：${marker}`)
}
for (const retiredMarker of ['round-nav-from-start', 'round-nav-latest']) {
  if (reviewPage.includes(retiredMarker)) throw new Error(`Review 不得继续私有渲染边界导航按钮：${retiredMarker}`)
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

const turnRailOwner = readFileSync(turnRailOwnerPath, 'utf8')
if (!/\.task-turn-rail \.turn-tick\s*\{[^}]*width:\s*24px;[^}]*height:\s*9px;/s.test(turnRailOwner)) {
  throw new Error('Turn Rail 每个 tick 的 24×9px 命中区必须统一，状态不得改变轮次间距')
}
if (!/\.task-turn-rail \.turn-tick i\s*\{[^}]*width:\s*6px;[^}]*height:\s*1\.5px;/s.test(turnRailOwner)) {
  throw new Error('Turn Rail 基础标记必须固定为 6×1.5px')
}
const stateGeometryRule = /\.task-turn-rail \.turn-tick\.(?:active|running|err)[^{]*\{[^}]*(?:width|height)\s*:/s
if (stateGeometryRule.test(turnRailOwner)) {
  throw new Error('Turn Rail active / running / error 只能改变颜色、透明度或光晕，不得修改 width / height')
}
const hoverRule = turnRailOwner.match(/\.task-turn-rail \.turn-tick:hover i\s*\{([^}]*)\}/s)?.[1] ?? ''
if (!hoverRule || /height\s*:/.test(hoverRule)) {
  throw new Error('Turn Rail hover 只允许横向展开，不得改变固定 1.5px 线条粗细')
}
const activeRule = turnRailOwner.match(/\.task-turn-rail \.turn-tick\.active i\s*\{([^}]*)\}/s)?.[1] ?? ''
if (!activeRule || !activeRule.includes('var(--al-ink)')) {
  throw new Error('Turn Rail active 必须只通过共享状态颜色强调当前轮次')
}
const runningRule = turnRailOwner.match(/\.task-turn-rail \.turn-tick\.running i\s*\{([^}]*)\}/s)?.[1] ?? ''
if (!runningRule || !runningRule.includes('var(--al-accent)') || !runningRule.includes('box-shadow')) {
  throw new Error('Turn Rail running 必须保留强调色与轻量光晕，但不得改变固定几何')
}
if (/\.task-turn-rail-(?:review|live)\b/.test(turnRailOwner)) {
  throw new Error('Review / Pi Live 不得拥有模式专属 Turn Rail 样式；两者必须消费同一导轨视觉')
}
for (const marker of [
  '.task-boundary-nav {',
  '.task-boundary-nav > .ui-icon-button {',
  'width: 42px;',
  'height: 42px;',
]) {
  if (!turnRailOwner.includes(marker)) throw new Error(`Task BoundaryNav 缺少共享视觉契约：${marker}`)
}
for (const retiredMarker of [
  '.task-boundary-nav-live',
  '.task-boundary-nav-review',
  'round-nav-from-start',
  'round-nav-latest',
]) {
  if (turnRailOwner.includes(retiredMarker)) throw new Error(`边界导航不得保留页面/模式专属视觉：${retiredMarker}`)
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
const turnRailSelector = /\.(?:task-turn-rail(?:\b|-)|turn-tick(?:\b|-)|task-boundary-nav(?:\b|-))/g
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

  if (file !== 'task-turn-rail.css') {
    const railSelectors = [...new Set(source.match(turnRailSelector) ?? [])]
    if (railSelectors.length) throw new Error(`${file} 越权定义统一 Turn Rail / BoundaryNav 选择器：${railSelectors.slice(0, 8).join(', ')}`)
  }
}

for (const component of ['TaskHeader.tsx', 'TaskRound.tsx', 'TaskMessage.tsx', 'TaskThinking.tsx', 'TaskToolGroup.tsx', 'TaskToolRow.tsx', 'TaskEvent.tsx']) {
  const path = `${webRoot}/features/${component}`
  const source = readFileSync(path, 'utf8')
  if (/import\s+['\"][^'\"]+\.css['\"]/.test(source)) {
    throw new Error(`${component} 不得私有导入 CSS；组件表现统一由 task-detail.css 持有，会话几何统一由 task-session-view.css 持有`)
  }
}

console.log('Task 样式所有权检查通过：TaskSurface 统一 Session 槽位、语义 Turn Rail 与 BoundaryNav；Review / Pi Live 共用 Rail Frame，tick 固定 6×1.5px，状态不改变几何。')
