import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')
const overview = read('./AgentsResponsivePage.tsx')
const agent = read('./AgentsPage.tsx')
const tabs = read('../components/WorkspaceViewTabs.tsx')
const sharedCss = read('../components/workspace-sidebar.css')
const css = read('../agents.css')
const shellCss = read('../shell.css')
const responsiveCss = read('../agent-insights-responsive.css')
const backupPage = read('./BackupPage.tsx')
const preview = read('../components/AgentManagedFilesDialog.tsx')

test('Pi ecosystem links live within agent card instead of a fourth full-width workspace row', () => {
  assert.doesNotMatch(overview, /<WorkspaceViewTabs/)
  assert.match(agent, /<WorkspaceViewTabs inline/)
  assert.match(tabs, /inline \? 'is-inline'/)
  assert.match(sharedCss, /\.workspace-view-tabs\.is-inline/)
  assert.match(agent, /to: '\/agents\?agent=pi&view=ecosystem'/)
  assert.match(agent, /to: '\/agents\?agent=pi'/)
})

test('Pi inline tabs stay anchored beside agent identity as content width changes', () => {
  assert.match(agent, /className=\{`agent-card-head \$\{isPi \? 'has-inline-tabs' : ''\}`\.trim\(\)\}/)
  assert.match(css, /\.agent-card-head\.has-inline-tabs \.agent-identity \{ flex: 0 1 auto; \}/)
  assert.match(css, /\.agent-card-head\.has-inline-tabs \.agent-status \{ margin-left: auto; \}/)
  assert.match(overview, /\[activeView\]/)
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

test('full-width scrollbars keep the centered reading axis across ordinary workspaces', () => {
  assert.match(shellCss, /\.page-content\s*\{[^}]*width: 100%;[^}]*overflow: auto;/s)
  assert.doesNotMatch(shellCss, /\.page-content\s*\{[^}]*max-width:/s)
  assert.match(shellCss, /\.backup-content\s*\{[^}]*calc\(\(100% - var\(--al-workspace-content-max/s)
  assert.match(responsiveCss, /\.agents-responsive-shell\s*\{[^}]*overflow: auto;/s)
  assert.match(responsiveCss, /\.agents-overview-layout\s*\{[^}]*max-width: var\(--al-workspace-content-max/s)
  assert.match(overview, /className=\{`agents-overview-layout/)
  assert.match(sharedCss, /\.agents-overview-layout > \.workspace-page/)
})

test('agent and backup tab switches reset the reading position instead of hiding the top', () => {
  assert.match(overview, /shellRef\.current\.scrollTop = 0/)
  assert.match(backupPage, /contentRef\.current\.scrollTop = 0/)
})
