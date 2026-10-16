import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../features/LiveTaskPage.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const taskCenter = readFileSync(new URL('../features/TaskCenterPage.tsx', import.meta.url), 'utf8')

test('结束任务入口只属于统一 Live 页面，不再路由旧 Pi 页面', () => {
  assert.match(page, /onClick=\{\(\) => void terminate\(\)\}/)
  assert.match(page, /variant="danger"/)
  assert.match(shell, /path="\/review\/live\/:liveId\/:runtimeSessionId"/)
  assert.match(taskCenter, /mode === 'live' && <LiveTaskPage embedded\/>/)
  assert.equal(existsSync(new URL('../features/PiLivePage.tsx', import.meta.url)), false)
})
