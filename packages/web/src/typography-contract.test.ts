import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const typography = readFileSync(new URL('./typography.css', import.meta.url), 'utf8')

test('字体响应式只跟随共享 lg 边界，不保留 900px 私有断点', () => {
  assert.doesNotMatch(typography, /@media\s*\(max-width:\s*900px\)/)
  assert.match(typography, /@media\s*\(max-width:\s*991\.98px\)/)
})
