import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')

test('desktop viewport evidence keeps a fast CDP probe with a size-checked Electron fallback', () => {
  assert.match(source, /win\.setContentSize\(viewport\.width, viewport\.height\)/)
  assert.match(source, /Page\.captureScreenshot/)
  assert.match(source, /captureBeyondViewport:\s*false/)
  assert.match(source, /\}\), 3_000, `\$\{viewport\.width\}×\$\{viewport\.height\} \$\{theme\} CDP 截图`\)/)
  assert.match(source, /win\.webContents\.capturePage\(\)/)
  assert.match(source, /image\.isEmpty\(\)/)
  assert.match(source, /Math\.abs\(size\.width - viewport\.width\) > 2/)
  assert.match(source, /Math\.abs\(size\.height - viewport\.height\) > 2/)
})

test('switch stability waits for the async task list without weakening the 100-switch performance gate', () => {
  assert.match(source, /for \(let attempt = 0; attempt < 80; attempt \+= 1\)/)
  assert.match(source, /if \(initialCount >= 2\) break/)
  assert.match(source, /await delay\(50\)/)
  assert.match(source, /任务列表在 4 秒内未就绪/)
  assert.match(source, /skipped: true[^\n]+ok: false/)
  assert.match(source, /clickTaskSequence\(win, 100\)/)
  assert.match(source, /withTimeout\(runSwitchStability\(switchWin\), 25_000, '100 次任务切换稳定性'\)/)
  assert.doesNotMatch(source, /真实任务不足 2 条[^\n]+ok: true/)
})
