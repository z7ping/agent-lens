import assert from 'node:assert/strict'
import test from 'node:test'
import { BUILTIN_AGENT_LENS_ENGLISH_LOCALE, OFFICIAL_AGENT_LENS_LOCALE } from '@agent-lens/protocol'
import {
  listLocalePacks,
  localePack,
  registerLocalePack,
  resetLocaleRegistry,
} from './registry'

test('registry keeps built-in zh-CN baseline and en-US in stable order', () => {
  resetLocaleRegistry()
  assert.deepEqual(
    listLocalePacks().slice(0, 2).map(pack => pack.locale),
    [OFFICIAL_AGENT_LENS_LOCALE, BUILTIN_AGENT_LENS_ENGLISH_LOCALE],
  )
})

test('community Locale Pack is declarative and independently registerable', () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'fr-FR',
    name: 'Community French Test',
    compatibility: { agentLensMajor: 1 },
    messages: {
      common: { loadingWorkspace: 'Loading workspace' },
    },
  })

  assert.equal(localePack('fr-fr')?.name, 'Community French Test')
  assert.equal(localePack('zh-CN')?.name, '简体中文')
})

test('registry rejects duplicate community locale and built-in locale overrides', () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'fr-FR',
    name: 'First French',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { ok: 'OK' } },
  })

  assert.throws(() => registerLocalePack({
    localeApiVersion: 1,
    locale: 'fr-FR',
    name: 'Duplicate French',
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

  assert.throws(() => registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Fake English',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { appName: 'Fake' } },
  }))
})
