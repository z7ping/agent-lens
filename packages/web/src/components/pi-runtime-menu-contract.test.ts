import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const menu = readFileSync(new URL('./PiRuntimeMenu.tsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('../features/PiLivePage.tsx', import.meta.url), 'utf8')

test('Pi Live 将 Runtime 生命周期操作收进标准更多菜单并二次确认', () => {
  assert.match(page, /<PiRuntimeMenu busy=\{busy\}/)
  assert.doesNotMatch(page, /variant="danger" className="pi-live-menu"/)
  assert.doesNotMatch(page, /title="结束 Pi Runtime" aria-label="结束 Pi Runtime"/)
  assert.match(menu, /<UiIcon name="more" size=\{14\}\/>/)
  assert.match(menu, /<Popover[\s\S]*?role="menu"/)
  assert.match(menu, />结束 Pi Runtime<\/button>/)
  assert.match(menu, /<Dialog[\s\S]*?title="结束 Pi Runtime？"/)
  assert.match(menu, /variant="danger"[\s\S]*?>结束 Runtime<\/Button>/)
  assert.match(menu, /停止当前任务/)
})
