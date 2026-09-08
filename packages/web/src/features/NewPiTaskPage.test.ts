import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PROJECT_BOOTSTRAP_LIMIT } from './new-pi-task'

const appPath = fileURLToPath(new URL('../App.tsx', import.meta.url))
const pagePath = fileURLToPath(new URL('./NewPiTaskPage.tsx', import.meta.url))
const desktopWorkspacePath = fileURLToPath(new URL('../client/desktop-workspace.ts', import.meta.url))

test('new Pi task bootstrap stays bounded and does not initialize review history', async () => {
  assert.equal(PROJECT_BOOTSTRAP_LIMIT, 20)
  const app = await readFile(appPath, 'utf8')
  assert.match(app, /if \(onLocalReview\) void model\.ensureReview\(\)/)
  assert.doesNotMatch(app, /if \(onReview\) void model\.ensureReview\(\)/)
  assert.match(app, /path="\/review\/new" element=\{<NewPiTaskPage\/>\}/)
})

test('new Pi task exposes a visible elapsed operation state before entering Live', async () => {
  const page = await readFile(pagePath, 'utf8')
  assert.match(page, /starting \? <div className="task-center-new-operation"><OperationProgress/)
  assert.match(page, /title="正在进入 Pi 实时任务"/)
  assert.match(page, /elapsedMs=\{startingElapsedMs\}/)
})

test('desktop new Pi task can select an unobserved local workspace without manual cwd input', async () => {
  const [page, bridge] = await Promise.all([
    readFile(pagePath, 'utf8'),
    readFile(desktopWorkspacePath, 'utf8'),
  ])
  assert.match(page, /selectDesktopWorkspace\(\)/)
  assert.match(page, />选择文件夹</)
  assert.match(page, /key: `workspace:\$\{cwd\}`/)
  assert.match(bridge, /window\.agentLensDesktop!\.selectWorkspace\(\)/)
})
