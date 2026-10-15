import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../App.tsx', import.meta.url))
const pagePath = fileURLToPath(new URL('./TaskCenterPage.tsx', import.meta.url))
const projectClientPath = fileURLToPath(new URL('../client/launchable-projects.ts', import.meta.url))
const newTaskPanelPath = fileURLToPath(new URL('./LiveNewTaskPanel.tsx', import.meta.url))

test('新建 Pi 任务复用任务中心 rail，并从统一服务端项目发现读取候选', async () => {
  const [app, page, projectClient, newTaskPanel] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(pagePath, 'utf8'),
    readFile(projectClientPath, 'utf8'),
    readFile(newTaskPanelPath, 'utf8'),
  ])

  assert.match(app, /if \(onLocalReview && onReviewIndex\) void model\.ensureReview\(\)/)
  assert.doesNotMatch(app, /if \(onReview\) void model\.ensureReview\(\)/)
  assert.match(app, /path="\/review\/new" element=\{<TaskCenterPage model=\{model\} mode="new" sidebarHost=\{sidebarHost\}\/>\}/)
  assert.match(page, /createPortal\(taskRail, sidebarHost\)/)

  assert.match(page, /fetchLaunchableProjects\(/)
  assert.match(page, /setLaunchableProjects\(cached\?\.items \?\? \[\]\)/)
  assert.match(page, /setLaunchableProjects\(value\.items\)/)
  assert.match(page, /setLaunchableProjects\(current => mergeLaunchableProjects\(current, value\.items\)\)/)
  assert.match(page, /launchableProjects\.length > 0[\s\S]{0,180}launchablePage\?\.nextCursor/)
  assert.match(page, /void loadMoreProjects\(\)/)
  assert.match(newTaskPanel, /projectSelectionInitializedRef\.current \|\| projectSearchActive \|\| !options\.length/)
  assert.match(newTaskPanel, /projectSelectionInitializedRef\.current = true/)
  assert.match(newTaskPanel, /setSelectedKey\(pickTaskProject\(options, preferredProjectId\)\?\.key \?\? ''\)/)
  assert.doesNotMatch(newTaskPanel, /setSelectedKey\(current =>/)
  assert.match(newTaskPanel, /!selectedProject \|\| !available/)
  assert.match(newTaskPanel, /event\.nativeEvent\.isComposing && event\.nativeEvent\.keyCode !== 229/)
  assert.match(newTaskPanel, /onSearchChange=\{onProjectSearch\}/)
  assert.match(newTaskPanel, /onLoadMore=\{onProjectLoadMore\}/)
  assert.doesNotMatch(page, /fetchLocalReviewSessions/)
  assert.doesNotMatch(page, /PROJECT_BOOTSTRAP_LIMIT/)
  assert.doesNotMatch(page, /projectHistory/)
  assert.match(projectClient, /\/api\/v1\/projects\/launchable/)
})

test('新建实时任务的目录选择只回填路径，启动前校验路径并使用统一白色内容区', async () => {
  const [page, panel, styles, chinese, english] = await Promise.all([
    readFile(pagePath, 'utf8'),
    readFile(newTaskPanelPath, 'utf8'),
    readFile(fileURLToPath(new URL('../task-center.css', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../i18n/zh-CN/task.ts', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../i18n/en-US/task.ts', import.meta.url)), 'utf8'),
  ])

  const picker = panel.slice(panel.indexOf('const selectDirectory = async'), panel.indexOf('const startManualDirectory = async'))
  assert.match(picker, /selectHostProjectDirectory\(\)/)
  assert.match(picker, /if \(path\) setManualDirectory\(path\)/)
  assert.doesNotMatch(picker, /await start\(/)
  assert.doesNotMatch(panel, /selectDirectoryAndStart|manualDirectoryOpen/)
  assert.match(panel, /isAbsoluteWorkspacePath\(path\)/)
  assert.match(panel, /directoryIsInvalid \|\| undefined/)
  assert.match(panel, /recentDirectories\.map\(/)
  assert.match(panel, /validateHostProjectDirectory\(directoryPath, controller\.signal\)/)
  assert.match(panel, /controller\.abort\(\)/)
  assert.match(panel, /directoryIsVerified/)
  assert.match(panel, /disabled=\{!available \|\| selectingDirectory \|\| !directoryIsVerified\}/)
  assert.match(page, /nativeDirectoryPicker=\{snapshot\.health\?\.runtime\?\.mode === 'foreground'[\s\S]{0,140}Electron/)
  assert.match(styles, /\.task-center-new \{[^}]*background: var\(--al-surface\)/)
  assert.doesNotMatch(styles, /\.task-center-new-card \{[^}]*box-shadow:/)
  assert.match(chinese, /newProject: '选择其他目录'/)
  assert.match(english, /newProject: 'Other directory'/)
})
