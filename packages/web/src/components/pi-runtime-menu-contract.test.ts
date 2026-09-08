import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const action = readFileSync(new URL('./PiRuntimeMenu.tsx', import.meta.url), 'utf8')
const page = readFileSync(new URL('../features/PiLivePage.tsx', import.meta.url), 'utf8')
const icons = readFileSync(new URL('./UiIcon.tsx', import.meta.url), 'utf8')

test('Pi Live 用标准 30px IconButton + 16px 电源图标承载 Runtime 结束操作，并保留二次确认', () => {
  assert.match(page, /<PiRuntimeMenu busy=\{busy\}/)
  assert.match(action, /variant="danger"/)
  assert.doesNotMatch(action, /size="small"/)
  assert.match(action, /title="结束 Pi Runtime"/)
  assert.match(action, /aria-label="结束 Pi Runtime"/)
  assert.match(action, /<UiIcon name="power" size=\{16\}\/>/)
  assert.doesNotMatch(action, /<Popover/)
  assert.doesNotMatch(action, /role="menu"/)
  assert.match(action, /<Dialog[\s\S]*?title="结束 Pi Runtime？"/)
  assert.match(action, /variant="danger"[\s\S]*?>结束 Runtime<\/Button>/)
  assert.match(action, /停止当前任务/)
  assert.match(icons, /\bPower\b/)
  assert.match(icons, /power: Power/)
})
