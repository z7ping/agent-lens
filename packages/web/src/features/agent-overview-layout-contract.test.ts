import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const overview = read('./AgentsResponsivePage.tsx')
const agent = read('./AgentsPage.tsx')
const tabs = read('../components/WorkspaceViewTabs.tsx')
const sharedCss = read('../components/workspace-sidebar.css')
const css = read('../agents.css')
const preview = read('../components/AgentManagedFilesDialog.tsx')

test('Pi ecosystem links live within agent card instead of a fourth full-width workspace row', () => {
  assert.doesNotMatch(overview, /<WorkspaceViewTabs/)
  assert.match(agent, /<WorkspaceViewTabs inline/)
  assert.match(tabs, /inline \? 'is-inline'/)
  assert.match(sharedCss, /\.workspace-view-tabs\.is-inline/)
  assert.match(agent, /to: '\/agents\?agent=pi&view=ecosystem'/)
  assert.match(agent, /to: '\/agents\?agent=pi'/)
})

test('installation selector has actual dedup and one-line directory label', () => {
  assert.match(agent, /installationChoices\(agent\.installations\)/)
  assert.match(agent, /options=\{choices\.map\(/)
  assert.match(agent, /choices\.length > 1/)
  assert.match(css, /\.agent-installation \.agent-config > small \{[^}]*white-space: nowrap/)
  assert.doesNotMatch(css, /!important/)
})

test('markdown preview keeps rendered/source labels on one line', () => {
  assert.match(preview, /managed-file-view-toggle/)
  assert.match(css, /\.managed-file-view-toggle button \{[^}]*white-space: nowrap/)
  assert.match(css, /\.agent-managed-files-dialog \.ui-overlay-header-actions \{[^}]*white-space: nowrap/)
  assert.match(css, /\.agent-managed-files-dialog \.ui-overlay-header-actions > \* \{ flex-shrink: 0; \}/)
})
