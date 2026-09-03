import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./Primitives.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./ui-primitives.css', import.meta.url), 'utf8')
const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('./Overlay.tsx', import.meta.url), 'utf8')
const overlayCss = readFileSync(new URL('./overlay.css', import.meta.url), 'utf8')
const piStartup = readFileSync(new URL('../PiStartupDisclosure.tsx', import.meta.url), 'utf8')
const piStartupCss = readFileSync(new URL('../pi-startup-disclosure.css', import.meta.url), 'utf8')
const composerPill = readFileSync(new URL('../ComposerPillSelect.tsx', import.meta.url), 'utf8')
const stateViews = readFileSync(new URL('../StateViews.tsx', import.meta.url), 'utf8')
const piLivePage = readFileSync(new URL('../../features/PiLivePage.tsx', import.meta.url), 'utf8')
const piLiveCss = readFileSync(new URL('../../pi-live.css', import.meta.url), 'utf8')
const taskCenterPage = readFileSync(new URL('../../features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const taskCenterCss = readFileSync(new URL('../../task-center.css', import.meta.url), 'utf8')
const agentRules = readFileSync(new URL('../../../../../AGENTS.md', import.meta.url), 'utf8')

test('shared UI primitives expose the first unified component set', () => {
  for (const name of ['Button', 'IconButton', 'Input', 'Textarea', 'Select', 'StatusBadge', 'Disclosure', 'Toolbar', 'ToolbarGroup']) {
    assert.match(source, new RegExp(`export function ${name}\\b`))
  }
  assert.match(source, /role = 'toolbar'/)
  assert.match(index, /export \{ Dialog, Drawer \} from '\.\/Overlay'/)
  assert.match(index, /export \{ SelectMenu \} from '\.\.\/SelectMenu'/)
  assert.match(index, /ToolbarGroupProps/)
  assert.match(index, /ToolbarProps/)
})

test('shared controls keep the frozen size and typography contracts', () => {
  assert.match(css, /\.ui-icon-button \{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/)
  assert.match(css, /\.ui-icon-button\.is-small \{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/)
  assert.match(css, /\.ui-field \{[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*13px;/)
  assert.match(css, /\.ui-status-badge \{[\s\S]*?font-size:\s*12px;/)
  assert.doesNotMatch(overlayCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('shared primitives consume semantic tokens instead of page palettes', () => {
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/)
  assert.doesNotMatch(overlayCss, /#[0-9a-fA-F]{3,8}\b/)
  assert.match(css, /var\(--al-accent\)/)
  assert.match(css, /var\(--al-danger\)/)
  assert.match(css, /var\(--al-line-strong\)/)
})

test('Dialog and Drawer own the common accessibility behavior', () => {
  assert.match(overlay, /event\.key === 'Escape'/)
  assert.match(overlay, /event\.key !== 'Tab'/)
  assert.match(overlay, /aria-modal="true"/)
  assert.match(overlay, /previous\?\.focus/)
  assert.match(overlay, /export function Dialog/)
  assert.match(overlay, /export function Drawer/)
})

test('Pi startup actions consume the shared Button contract', () => {
  assert.match(piStartup, /import \{ Button \} from '\.\/ui'/)
  assert.match(piStartup, /<Button size="small"/)
  assert.match(piStartup, /variant="primary"/)
  assert.match(piStartup, /variant="danger"/)
  assert.doesNotMatch(piStartupCss, /\.pi-startup-actions button\s*\{/)
  assert.doesNotMatch(piStartupCss, /font-size:\s*(?:10(?:\.5)?|11(?:\.5)?)px/)
})

test('existing shared composites route common controls through the UI layer', () => {
  assert.match(composerPill, /import \{ SelectMenu, type SelectMenuOption \} from '\.\/ui'/)
  assert.match(stateViews, /import \{ Button \} from '\.\/ui'/)
  assert.match(stateViews, /<Button variant="primary"/)
  assert.doesNotMatch(stateViews, /className="state-button/)
})

test('Pi Live routes common actions and fields through the UI layer', () => {
  assert.match(piLivePage, /import \{ Button, IconButton, Input, Textarea \} from '\.\.\/components\/ui'/)
  assert.match(piLivePage, /<Button size="small" variant="primary" onClick=\{\(\) => onAnswer/)
  assert.match(piLivePage, /<Textarea className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<Input className="pi-live-blocking-field"/)
  assert.match(piLivePage, /<IconButton[\s\S]*?className="pi-live-editor-action"/)
  assert.match(piLivePage, /<IconButton variant="primary" className="pi-live-send"/)
  assert.match(piLivePage, /className="pi-live-queue-action"/)

  for (const obsolete of [
    /\.pi-live-blocking button\s*\{/,
    /\.pi-live-startup-queue button\s*\{/,
    /\.pi-live-queue-item button\s*\{/,
    /\.pi-live-editor-toolbar button\s*\{/,
    /\.pi-live-compose-settings select\s*\{/,
  ]) assert.doesNotMatch(piLiveCss, obsolete)
  assert.match(piLiveCss, /\.pi-live-model-picker \{[\s\S]*?width:\s*clamp/)
  assert.match(piLiveCss, /\.pi-live-thinking-picker \{[\s\S]*?width:\s*clamp/)
})

test('Task Center toolbar and common actions consume the UI layer', () => {
  assert.match(taskCenterPage, /import \{ Button, IconButton, Input, SelectMenu, Toolbar \} from '\.\.\/components\/ui'/)
  assert.doesNotMatch(taskCenterPage, /from '\.\.\/components\/SelectMenu'/)
  assert.match(taskCenterPage, /<Toolbar className="task-center-toolbar" aria-label="筛选历史任务">/)
  assert.match(taskCenterPage, /<Input className="filter search-filter"/)
  assert.match(taskCenterPage, /<IconButton onClick=\{\(\) => void model\.refreshReview\(\)\}/)
  assert.match(taskCenterPage, /<Button size="small" variant="primary" onClick=\{newTask\}>/)
  assert.match(taskCenterPage, /<Button variant="primary" loading=\{starting\}/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-toolbar \.icon-button/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-rail-head \.btn\s*\{/)
  assert.doesNotMatch(taskCenterCss, /\.task-center-new-actions \.btn\s*\{[^}]*min-height:/s)
  assert.match(taskCenterCss, /\.task-center-toolbar \.ui-icon-button/)
})

test('repository agent rules require reuse of shared primitives', () => {
  assert.match(agentRules, /UI \/ 组件契约（强制）/)
  assert.match(agentRules, /已有对应 Primitive 时，页面不得自行重新实现/)
  assert.match(agentRules, /TaskSurface/)
  assert.match(agentRules, /正常可见文字不得低于 `12px`/)
})
