import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocaleRegistry } from './registry'

test('registers partial locale pack and falls back to Chinese', async () => {
  const registry = createLocaleRegistry()
  await registry.initialize()
  registry.register({
    locale: 'en-US',
    name: 'English',
    agentLensLocaleVersion: 1,
    messages: {
      'common.close': 'Close',
    },
  })
  await registry.change('en-US')
  assert.equal(registry.i18n.t('common.close'), 'Close')
  assert.equal(registry.i18n.t('shell.nav.tasks'), '任务')
})

test('invalid locale pack does not replace the official baseline', async () => {
  const registry = createLocaleRegistry()
  await registry.initialize()
  assert.throws(() => registry.register({
    locale: 'zh-CN',
    name: 'Override',
    agentLensLocaleVersion: 1,
    messages: { 'common.close': 'x' },
  }))
  assert.equal(registry.i18n.t('common.close'), '关闭')
})
