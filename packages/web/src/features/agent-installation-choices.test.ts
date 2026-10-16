import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentAssetBindingDto, AgentInstallationOverviewDto } from '@agent-lens/protocol'
import { assetBindingChoices, installationChoiceKey, installationChoices } from './agent-installation-choices'

const installation = (id: string, configRoot: string, version = '0.84.4'): AgentInstallationOverviewDto => ({
  id,
  configRoot,
  version,
  firstSeenAt: '2026-10-15T00:00:00.000Z',
  lastSeenAt: '2026-10-15T01:00:00.000Z',
})

test('配置目录跨版本与路径别名只展示一次，底层记录保留', () => {
  const items = [
    installation('one', 'C:\\Users\\Administrator\\.pi\\agent'),
    installation('two', 'c:/users/administrator/.pi/agent/'),
    installation('three', 'C:/Users/Administrator/.pi/agent', '1.0.0'),
    installation('four', 'C:/Users/Administrator/.pi/another'),
  ]
  assert.deepEqual(installationChoices(items).map(item => item.id), ['one', 'four'])
  assert.equal(items.length, 4, 'underlying observations must remain untouched')
})

test('同目录采用最近扫描的安装记录，不把旧版本显示为另一个配置目录', () => {
  const old = installation('old', 'C:/Agents/Pi', '0.84.4')
  const current = { ...installation('current', 'c:\\Agents\\Pi', '1.2.0'), lastSeenAt: '2026-10-16T00:00:00.000Z' }
  const missingVersion = installation('unknown', 'C:/Agents/Pi')
  delete missingVersion.version
  assert.deepEqual(installationChoices([old, missingVersion, current]).map(item => item.id), ['current'])
  assert.equal(installationChoiceKey(old), installationChoiceKey(current))
})

test('installation options use a data-root fallback without discarding unknown paths', () => {
  const first = installation('first', '')
  delete first.configRoot
  first.dataRoot = '/tmp/pi-data'
  const second = installation('second', '')
  delete second.configRoot
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

test('同文件的多条历史安装关联合并为一个位置，不混淆不同项目或作用范围', () => {
  const binding = (id: string, path: string, scope: AgentAssetBindingDto['scope'] = 'user'): AgentAssetBindingDto => ({
    id, installationId: id, path, scope, scopeRoot: 'C:/Agents/Pi', states: [],
  })
  const global = binding('global-old', 'C:/Agents/Pi/AGENTS.md')
  const current: AgentAssetBindingDto = { ...binding('global-current', 'c:\\Agents\\Pi\\AGENTS.md'), states: [{ state: 'installed', value: true, observedAt: '2026-10-16T00:00:00.000Z', evidenceCount: 1 }] }
  const rows = [global, binding('global-other', 'C:/Agents/Pi/AGENTS.md'), current,
    binding('project', 'C:/work/auth-center/CLAUDE.md', 'project'),
    binding('project-duplicate', 'c:\\work\\auth-center\\CLAUDE.md', 'project'),
    binding('other-project', 'C:/work/other/CLAUDE.md', 'project'),
    binding('different-scope', 'C:/Agents/Pi/AGENTS.md', 'project')]
  assert.deepEqual(assetBindingChoices(rows).map(item => item.id), ['global-current', 'project', 'other-project', 'different-scope'])
  assert.equal(rows.length, 7)
})
