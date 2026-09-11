import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appPath = fileURLToPath(new URL('../App.tsx', import.meta.url))
const pagePath = fileURLToPath(new URL('./TaskCenterPage.tsx', import.meta.url))
const projectClientPath = fileURLToPath(new URL('../client/launchable-projects.ts', import.meta.url))

test('新建 Pi 任务复用任务中心 rail，并从统一服务端项目发现读取候选', async () => {
  const [app, page, projectClient] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(pagePath, 'utf8'),
    readFile(projectClientPath, 'utf8'),
  ])

  assert.match(app, /if \(onLocalReview\) void model\.ensureReview\(\)/)
  assert.doesNotMatch(app, /if \(onReview\) void model\.ensureReview\(\)/)
  assert.match(app, /path="\/review\/new" element=\{<TaskCenterPage model=\{model\} mode="new" sidebarHost=\{sidebarHost\}\/>\}/)
  assert.match(page, /createPortal\(taskRail, sidebarHost\)/)

  assert.match(page, /fetchLaunchableProjects\(/)
  assert.match(page, /onSearchChange=\{onProjectSearch\}/)
  assert.match(page, /onLoadMore=\{onProjectLoadMore\}/)
  assert.doesNotMatch(page, /fetchLocalReviewSessions/)
  assert.doesNotMatch(page, /PROJECT_BOOTSTRAP_LIMIT/)
  assert.doesNotMatch(page, /projectHistory/)
  assert.match(projectClient, /\/api\/v1\/projects\/launchable/)
})
