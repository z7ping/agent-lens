import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentInstallationOverviewDto } from '@agent-lens/protocol'
import { installationChoiceKey, installationChoices } from './agent-installation-choices'

const installation = (id: string, configRoot: string, version = '0.84.4'): AgentInstallationOverviewDto => ({
  id,
  configRoot,
  version,
  firstSeenAt: '2026-10-15T00:00:00.000Z',
  lastSeenAt: '2026-10-15T01:00:00.000Z',
})

test('same version and directory are displayed only once even across slash/case aliases', () => {
  const items = [
    installation('one', 'C:\\Users\\Administrator\\.pi\\agent'),
    installation('two', 'c:/users/administrator/.pi/agent/'),
    installation('three', 'C:/Users/Administrator/.pi/agent', '1.0.0'),
    installation('four', 'C:/Users/Administrator/.pi/another'),
  ]
  assert.deepEqual(installationChoices(items).map(item => item.id), ['one', 'three', 'four'])
  assert.equal(items.length, 4, 'underlying observations must remain untouched')
})

test('installation options use a data-root fallback without discarding unknown paths', () => {
  const first = installation('first', '')
  first.configRoot = undefined
  first.dataRoot = '/tmp/pi-data'
  const second = installation('second', '')
  second.configRoot = undefined
  second.dataRoot = '/tmp/pi-data/'
  assert.deepEqual(installationChoices([first, second]).map(item => item.id), ['first'])
})

test('POSIX path casing is distinct while Windows roots are case-insensitive', () => {
  const choices = installationChoices([
    installation('upper', '/home/user/Agent'),
    installation('lower', '/home/user/agent'),
    installation('win-a', 'D:\\Agents\\Pi'),
    installation('win-b', 'd:/agents/pi/'),
  ])
  assert.deepEqual(choices.map(item => item.id), ['upper', 'lower', 'win-a'])
})

test('distinct IDs grouped in the selector share the same key for asset binding aggregation', () => {
  assert.equal(
    installationChoiceKey(installation('id-a', 'C:\\Users\\Administrator\\.pi\\agent')),
    installationChoiceKey(installation('id-b', 'c:/users/administrator/.pi/agent/')),
  )
})
