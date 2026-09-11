import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import {
  registerLocalePack,
  resetLocaleRegistry,
  resourceBundles,
} from './registry'

test('partial community Locale Pack falls back to official zh-CN', async () => {
  resetLocaleRegistry()
  registerLocalePack({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Partial English Test',
    compatibility: { agentLensMajor: 1 },
    messages: {
      navigation: {
        task: 'Tasks',
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
    interpolation: { escapeValue: false },
  })

  assert.equal(instance.t('navigation:task'), 'Tasks')
  assert.equal(instance.t('navigation:agents'), '智能体')
  assert.equal(instance.t('common:loadingWorkspace'), '正在加载工作区')
})
