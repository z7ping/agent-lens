import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')

test('desktop viewport evidence keeps CDP capture with a size-checked Electron fallback', () => {
  assert.match(source, /win\.setContentSize\(viewport\.width, viewport\.height\)/)
  assert.match(source, /Page\.captureScreenshot/)
  assert.match(source, /captureBeyondViewport:\s*false/)
  assert.match(source, /win\.webContents\.capturePage\(\)/)
  assert.match(source, /image\.isEmpty\(\)/)
  assert.match(source, /Math\.abs\(size\.width - viewport\.width\) > 2/)
  assert.match(source, /Math\.abs\(size\.height - viewport\.height\) > 2/)
})
