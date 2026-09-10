import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskSurface = readFileSync(new URL('./TaskSurface.tsx', import.meta.url), 'utf8')
const railCss = readFileSync(new URL('../task-turn-rail.css', import.meta.url), 'utf8')

test('窄窗长会话导航由共享 TaskSurface 持有并复用动态 Composer 边界', () => {
  assert.match(taskSurface, /className="task-compact-round-nav"/)
  assert.match(taskSurface, /style=\{\{ bottom: railPosition\.boundaryBottom \}\}/)
  assert.match(taskSurface, /activeRailIndex \+ 1\} \/ \{railItems\.length/)
  assert.match(taskSurface, /firstErrorItem = railItems\.find\(item => item\.error\)/)
  assert.match(taskSurface, /跳到错误轮次/)
})

test('lg 以下隐藏完整 Rail 与 Boundary，但显示 Compact Round Navigation', () => {
  assert.match(railCss, /@media \(max-width: 991\.98px\) \{[\s\S]*?\.task-turn-rail,[\s\S]*?\.task-boundary-nav \{ display: none; \}[\s\S]*?\.task-compact-round-nav \{ display: flex; \}/)
  assert.match(railCss, /\.task-compact-round-nav \{[\s\S]*?position: fixed;[\s\S]*?height: 44px;/)
})

test('Compact Round Navigation 保留最早、错误轮次与最新入口', () => {
  assert.match(taskSurface, /aria-label="跳到最早"/)
  assert.match(taskSurface, /aria-label=\{`跳到错误轮次：\$\{firstErrorItem\.label\}`\}/)
  assert.match(taskSurface, /aria-label="跳到最新"/)
})
