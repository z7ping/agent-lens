import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('./WorkspaceSidebar.tsx', import.meta.url), 'utf8')
const overlaySource = readFileSync(new URL('./ui/Overlay.tsx', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../shell-responsive.css', import.meta.url), 'utf8')

test('移动工作栏复用共享 Modal Focus Scope，而不是页面级键盘补丁', () => {
  assert.match(overlaySource, /export function useModalFocusScope/)
  assert.match(overlaySource, /event\.key === 'Escape'/)
  assert.match(overlaySource, /event\.key !== 'Tab'/)
  assert.match(overlaySource, /requestAnimationFrame\(\(\) => previous\?\.focus/)
  assert.match(sidebarSource, /useModalFocusScope\(\{ open: mobileOpen, onClose: onMobileClose, panelRef: sidebarRef \}\)/)
})

test('移动工作栏打开时具有 Dialog 语义并隔离主工作区', () => {
  assert.match(sidebarSource, /role=\{mobileOpen \? 'dialog' : undefined\}/)
  assert.match(sidebarSource, /aria-modal=\{mobileOpen \? 'true' : undefined\}/)
  assert.match(sidebarSource, /tabIndex=\{mobileOpen \? -1 : undefined\}/)
  assert.match(appSource, /main\.inert = mobileNavigationOpen/)
  assert.match(appSource, /<div ref=\{mainRef\} className="app-main">/)
})

test('移动工作栏继续使用既有 off-canvas Drawer 几何，不退回双列窄栏', () => {
  assert.match(responsiveCss, /@media \(max-width: 767\.98px\)[\s\S]*?\.app-shell \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(responsiveCss, /\.workspace-sidebar \{[\s\S]*?position: fixed;[\s\S]*?transform: translateX\(-102%\)/)
  assert.match(responsiveCss, /\.workspace-sidebar\.is-mobile-open \{[\s\S]*?transform: translateX\(0\)/)
  assert.match(responsiveCss, /\.workspace-mobile-backdrop \{[\s\S]*?position: fixed;/)
})
