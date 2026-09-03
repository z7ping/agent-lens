import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./Primitives.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./ui-primitives.css', import.meta.url), 'utf8')
const piStartup = readFileSync(new URL('../PiStartupDisclosure.tsx', import.meta.url), 'utf8')
const piStartupCss = readFileSync(new URL('../pi-startup-disclosure.css', import.meta.url), 'utf8')
const agentRules = readFileSync(new URL('../../../../../AGENTS.md', import.meta.url), 'utf8')

test('shared UI primitives expose the first unified component set', () => {
  for (const name of ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'StatusBadge', 'Disclosure', 'Toolbar', 'ToolbarGroup']) {
    assert.match(source, new RegExp(`export function ${name}\\b`))
  }
})

test('shared controls keep the frozen size and typography contracts', () => {
  assert.match(css, /\.ui-icon-button \{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/)
  assert.match(css, /\.ui-icon-button\.is-small \{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/)
  assert.match(css, /\.ui-field \{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/)
  assert.match(css, /\.ui-status-badge \{[\s\S]*?font-size:\s*12px;/)
})

test('shared primitives consume semantic tokens instead of page palettes', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.match(css, /var\(--al-accent\)/)
  assert.match(css, /var\(--al-danger\)/)
  assert.match(css, /var\(--al-line-strong\)/)
})

test('Pi startup actions consume the shared Button contract', () => {
  assert.match(piStartup, /import \{ Button \} from '\.\/ui'/)
  assert.match(piStartup, /<Button size="small"/)
  assert.match(piStartup, /variant="primary"/)
  assert.match(piStartup, /variant="danger"/)
  assert.doesNotMatch(piStartupCss, /\.pi-startup-actions button\s*\{/)
  assert.doesNotMatch(piStartupCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('repository agent rules require reuse of shared primitives', () => {
  assert.match(agentRules, /UI \/ 组件契约（强制）/)
  assert.match(agentRules, /已有对应 Primitive 时，页面不得自行重新实现/)
  assert.match(agentRules, /TaskSurface/)
  assert.match(agentRules, /正常可见文字不得低于 `12px`/)
})
