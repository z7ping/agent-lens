import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PROJECT_BOOTSTRAP_LIMIT } from './new-pi-task'

const appPath = fileURLToPath(new URL('../App.tsx', import.meta.url))
const pagePath = fileURLToPath(new URL('./TaskCenterPage.tsx', import.meta.url))

test('新建 Pi 任务复用任务中心 rail，并保持项目候选加载有界', async () => {
  assert.equal(PROJECT_BOOTSTRAP_LIMIT, 20)
  const [app, page] = await Promise.all([readFile(appPath, 'utf8'), readFile(pagePath, 'utf8')])
  assert.match(app, /if \(onLocalReview\) void model\.ensureReview\(\)/)
  assert.doesNotMatch(app, /if \(onReview\) void model\.ensureReview\(\)/)
  assert.match(app, /path="\/review\/new" element=\{<TaskCenterPage model=\{model\} mode="new" sidebarHost=\{sidebarHost\}\/>\}/)
  assert.match(page, /createPortal\(taskRail, sidebarHost\)/)
  assert.match(page, /fetchLocalReviewSessions\(PROJECT_BOOTSTRAP_LIMIT\)/)
})
