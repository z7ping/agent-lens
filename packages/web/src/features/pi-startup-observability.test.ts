import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const round = readFileSync(new URL('./PiLiveTaskRound.tsx', import.meta.url), 'utf8')
const disclosure = readFileSync(new URL('../components/PiStartupDisclosure.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/pi-startup-disclosure.css', import.meta.url), 'utf8')

test('Pi Live exposes real Runtime initialization stages, timings and failure location', () => {
  assert.match(page, /<PiStartupDisclosure/)
  assert.match(page, /event\.timings \?\? event\.initializationTimings/)
  assert.match(page, /initializationElapsedMs/)
  assert.match(disclosure, /state\.initializationTimings/)
  assert.match(disclosure, /startup\.stage\.startingWorker/)
  assert.match(disclosure, /startup\.stage\.loadingSdk/)
  assert.match(disclosure, /startup\.stage\.loadingResources/)
  assert.match(disclosure, /startup\.stage\.creatingSession/)
  assert.match(disclosure, /startup\.stage\.bindingExtensions/)
  assert.match(disclosure, /t\('startup\.stuckAt'/)
})

test('Pi startup detail mirrors actual loaded resource groups and extension startup output', () => {
  assert.match(page, /type === 'runtime_resources'/)
  assert.match(page, /type === 'runtime_output'/)
  assert.match(page, /startupResources/)
  assert.match(page, /startupOutput/)
  assert.match(disclosure, /t\('startup\.resource\.context'\)/)
  assert.match(disclosure, /t\('startup\.resource\.skills'\)/)
  assert.match(disclosure, /t\('startup\.resource\.prompts'\)/)
  assert.match(disclosure, /t\('startup\.resource\.extensions'\)/)
  assert.match(disclosure, /t\('startup\.resource\.themes'\)/)
  assert.match(disclosure, /resourceSummary/)
  assert.match(disclosure, /pi-startup-resource-details/)
  assert.match(disclosure, /t\('startup\.startupOutput'\)/)
  assert.match(disclosure, /Pi v\{sdkVersion\}/)
})

test('Pi initialization disclosure collapses after ready and expands on failure', () => {
  assert.match(disclosure, /state\.status === 'ready'\) setExpanded\(false\)/)
  assert.match(disclosure, /state\.status === 'failed'\) setExpanded\(true\)/)
  assert.match(disclosure, /onToggle=\{event => setExpanded\(event\.currentTarget\.open\)\}/)
})

test('ready startup summary stays on one compact line', () => {
  assert.match(disclosure, /state\.status !== 'ready' && <small>/)
  assert.match(css, /\.pi-startup-summary-copy \{[^}]*display:\s*flex;/)
  assert.match(css, /\.pi-startup-disclosure\.is-ready:not\(\[open\]\) > summary \{[^}]*min-height:\s*34px;/)
})

test('Pi startup status is merged into the background activity round', () => {
  assert.match(page, /id: 'background:startup'/)
  assert.match(page, /label: agentLensI18n\.t\('piLive:common\.backgroundActivity'\)/)
  assert.match(page, /projection\.model\.id === 'background:0'/)
  assert.match(page, /beforeContent=\{carriesStartup \? startupContent : undefined\}/)
  assert.match(page, /summaryMeta=\{carriesStartup \? startupSummaryMeta : undefined\}/)
  assert.match(page, /<PiStartupDisclosure[\s\S]*?embedded[\s\S]*?showAllEvents=\{showAllEvents\}/)
  assert.match(round, /beforeContent\?: ReactNode/)
  assert.match(round, /summaryMeta\?: ReactNode/)
  assert.match(round, /\{beforeContent\}/)
  assert.doesNotMatch(disclosure, /pi-startup-complete/)
  assert.match(disclosure, /if \(embedded\) return <OperationProgress/)
  assert.match(disclosure, /showAllEvents && startupOutput\.length > 0/)
  assert.match(disclosure, /showAllEvents && \(resources\?\.diagnostics\.length \?\? 0\) > 0/)
  assert.match(css, /\.pi-startup-inline \.pi-startup-body \{[^}]*padding:\s*1px 0 5px;/)
  assert.match(css, /\.pi-startup-inline \.pi-startup-steps \{[^}]*border-top:\s*0;/)
})

test('Pi initialization is a prominent local operation before settling into background history', () => {
  assert.match(page, /!state && <div className="pi-live-startup-spotlight"><OperationProgress/)
  assert.match(page, /startupState && startupState\.status !== 'ready' && <div className="pi-live-startup-spotlight">/)
  assert.match(page, /startupState\?\.status === 'ready' && !hasBackgroundRound/)
  assert.match(disclosure, /elapsedMs=\{elapsed\}/)
  assert.match(disclosure, /t\('startup\.loadingDescription'\)/)
})
