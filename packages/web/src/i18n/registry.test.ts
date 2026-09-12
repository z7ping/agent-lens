import assert from 'node:assert/strict'
import test from 'node:test'
import { OFFICIAL_AGENT_LENS_LOCALE } from '@agent-lens/protocol'
import {
  listLocalePacks,
  localePack,
  registerLocalePack,
  resetLocaleRegistry,
} from './registry'

test('registry always keeps official zh-CN as the baseline', () => {
  resetLocaleRegistry()
  assert.equal(listLocalePacks()[0]?.locale, OFFICIAL_AGENT_LENS_LOCALE)
})

test('community Locale Pack is declarative and independently registerable', () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Community English Test',
    compatibility: { agentLensMajor: 1 },
    messages: {
      common: { loadingWorkspace: 'Loading workspace' },
    },
  })

  assert.equal(localePack('en-us')?.name, 'Community English Test')
  assert.equal(localePack('zh-CN')?.name, '简体中文')
})

test('registry rejects duplicate community locale and official zh-CN override', () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'First',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { ok: 'OK' } },
  })

  assert.throws(() => registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Duplicate',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { ok: 'Duplicate' } },
  }))

  assert.throws(() => registerLocalePack({
    localeApiVersion: 1,
    locale: 'zh-CN',
    name: 'Fake Chinese',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { appName: 'Fake' } },
  }))
})
