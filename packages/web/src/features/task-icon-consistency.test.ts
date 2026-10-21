import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('TaskHeader info and view icons use shared IconButton rather than bordered text Button', () => {
  const header = read('./TaskHeader.tsx')
  assert.match(header, /<IconButton\s+size="small"\s+className="task-header-compact-info-trigger"/)
  assert.match(header, /<IconButton\s+size="small"\s+className="task-view-menu-trigger"/)
  assert.doesNotMatch(header, /<Button[\s>]/)
})

test('task icon states do not reintroduce business-specific selection borders', () => {
  const buttonCss = read('../components/ui/ui-primitives.css')
  const menuCss = read('../task-view-options.css')
  const railCss = read('../task-turn-rail.css')
  const sidebarCss = read('../components/workspace-sidebar.css')
  assert.match(buttonCss, /\.ui-icon-button\s*\{[^}]*border:\s*0;/s)
  assert.match(buttonCss, /aria-expanded='true'[^}]*color:\s*var\(--al-accent\);/s)
  assert.match(menuCss, /\.task-view-menu-trigger svg\s*\{[^}]*color:\s*currentColor;/s)
  assert.doesNotMatch(menuCss, /\.task-view-menu-trigger\[aria-expanded='true'\][^{]*\{[^}]*border-color:/s)
  assert.match(railCss, /\.task-boundary-nav > \.ui-icon-button\s*\{[^}]*border:\s*0;/s)
  assert.match(railCss, /\.task-compact-round-nav\s*\{[^}]*border:\s*0;/s)
  assert.doesNotMatch(sidebarCss, /\.task-center-search-refresh[^{}]*\{[^}]*border-color:/s)
})
