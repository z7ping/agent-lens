import { existsSync, readFileSync } from 'node:fs'

const mainPath = 'packages/web/src/main.tsx'
const canonicalPath = 'packages/web/src/task-detail.css'
const retiredPaths = [
  'packages/web/src/task-detail-prototype.css',
  'packages/web/src/task-detail-polish.css',
  'packages/web/src/task-feedback-polish.css',
]

for (const path of retiredPaths) {
  if (existsSync(path)) throw new Error(`Task Surface 不允许恢复临时覆盖层：${path}`)
}

if (!existsSync(canonicalPath)) {
  throw new Error(`Task Surface 缺少唯一正式样式所有者：${canonicalPath}`)
}

const main = readFileSync(mainPath, 'utf8')
const imports = [...main.matchAll(/import\s+['"](.+?\.css)['"]/g)].map(match => match[1])
const taskDetailImports = imports.filter(path => path.includes('task-detail'))
if (taskDetailImports.length !== 1 || taskDetailImports[0] !== './task-detail.css') {
  throw new Error(`Task Surface 必须且只能加载 ./task-detail.css；当前：${taskDetailImports.join(', ') || '无'}`)
}

for (const retired of ['./task-detail-prototype.css', './task-detail-polish.css', './task-feedback-polish.css']) {
  if (imports.includes(retired)) throw new Error(`main.tsx 不得重新加载临时样式层：${retired}`)
}

const canonical = readFileSync(canonicalPath, 'utf8')
for (const marker of [
  'Task Detail / Task Surface 唯一样式所有者',
  '.task-center-main .task-header',
  '.task-center-main .task-round',
  '.task-center-main .thinking-block',
  '.task-center-main .execution-group',
]) {
  if (!canonical.includes(marker)) throw new Error(`task-detail.css 缺少正式所有权契约：${marker}`)
}

const forbiddenTaskLayerPattern = /task-detail-(?:prototype|polish)|task-feedback-polish/
if (forbiddenTaskLayerPattern.test(main)) {
  throw new Error('main.tsx 检测到 Task Surface 临时覆盖层引用')
}

console.log('Task Surface 样式所有权检查通过：共享表现只由 task-detail.css 持有，临时覆盖层已退役。')
