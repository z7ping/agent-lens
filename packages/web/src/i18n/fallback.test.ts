import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import {
  registerLocalePack,
  resetLocaleRegistry,
  resourceBundles,
} from './registry'

test('missing community keys fall back to official zh-CN', async () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Community English Test',
    compatibility: { agentLensMajor: 1 },
    messages: {
      common: {
        loadingWorkspace: 'Loading workspace',
      },
    },
  })

  const instance = createInstance()
  await instance.init({
    resources: resourceBundles(),
    lng: 'en-US',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'navigation'],
  })

  assert.equal(instance.t('loadingWorkspace'), 'Loading workspace')
  assert.equal(instance.t('navigation:taskCenter'), '任务中心')
})

test('community pack cannot replace official zh-CN', () => {
  resetLocaleRegistry()
  assert.throws(() => registerLocalePack({
    localeApiVersion: 1,
    locale: 'zh-CN',
    name: 'Override',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { loadingWorkspace: 'override' } },
  }))
})
