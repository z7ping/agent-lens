import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { reduceLiveExtensionState, type LiveExtensionState } from './live-extension-state'

test('Pi extension keyed statuses update and clear without duplicating old content', () => {
  const initial: LiveExtensionState = { type: 'ui.state', kind: 'status', key: 'sync', text: '1/3' }
  let states = reduceLiveExtensionState([], initial)
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'sync', text: '2/3' })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'sync', text: '2/3' }])
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'build', text: 'running' })
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'sync', text: null })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'build', text: 'running' }])
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'build', text: '' })
  assert.deepEqual(states, [])
})

test('Pi widget and status keys are independent; clearing a widget keeps its status', () => {
  let states: LiveExtensionState[] = []
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'status', key: 'plan', text: 'Step 2',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Line 1', 'Line 2'],
    placement: 'aboveEditor',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Updated'],
    placement: 'belowEditor',
  })
  assert.equal(states.length, 2)
  assert.deepEqual(states[1], {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Updated'],
    placement: 'belowEditor',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: null,
  })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'plan', text: 'Step 2' }])
})

test('Pi ui.state stays transient: status is collapsed in Reader, widgets retain composer slot', () => {
  const page = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /extensionStatusItems = extensionUiState\.filter\(item => item\.kind === 'status'\)/)
  assert.match(page, /extensionWidgetItems = extensionUiState\.filter\(item => item\.kind === 'widget'\)/)
  const reader = page.indexOf('<div className="live-task-document">')
  const collapsed = page.indexOf('extensionStatusItems.length > 0 && <TaskThinking')
  const composer = page.indexOf('<TaskSessionComposer', reader)
  const widget = page.indexOf('extensionWidgetItems.map(item => <TaskEvent', collapsed)
  assert.ok(reader >= 0 && collapsed > reader && collapsed < composer)
  assert.ok(widget > collapsed && widget < composer, 'extension widgets remain immediately above the composer')
  assert.match(page, /kind="process"\s*defaultExpanded=\{false\}\s*expansionStore=\{processExpansionStore\}/)
  assert.doesNotMatch(page.slice(composer), /extensionStatusItems\.map/)
})
