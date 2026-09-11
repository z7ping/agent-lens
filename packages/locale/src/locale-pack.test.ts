import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_LENS_LOCALE_VERSION,
  LocalePackValidationError,
  validateLocalePack,
} from './locale-pack'

test('validates a partial declarative locale pack', () => {
  const pack = validateLocalePack({
    locale: 'en-us',
    name: 'English',
    agentLensLocaleVersion: AGENT_LENS_LOCALE_VERSION,
    messages: {
      'common.close': 'Close',
      'task.continueSession': 'Continue session',
    },
  })
  assert.equal(pack.locale, 'en-US')
  assert.equal(pack.messages['common.close'], 'Close')
})

test('rejects executable or nested message values', () => {
  assert.throws(() => validateLocalePack({
    locale: 'en-US',
    name: 'English',
    agentLensLocaleVersion: 1,
    messages: { common: { close: 'Close' } },
  }), LocalePackValidationError)
})

test('rejects unknown namespaces and prototype keys', () => {
  assert.throws(() => validateLocalePack({
    locale: 'en-US',
    name: 'English',
    agentLensLocaleVersion: 1,
    messages: { 'random.close': 'Close' },
  }), /未知 i18n namespace/)
  assert.throws(() => validateLocalePack({
    locale: 'en-US',
    name: 'English',
    agentLensLocaleVersion: 1,
    messages: { 'common.__proto__.pollute': 'x' },
  }), /保留字段/)
})

test('rejects incompatible contract and base-locale override', () => {
  assert.throws(() => validateLocalePack({
    locale: 'en-US',
    name: 'English',
    agentLensLocaleVersion: 2,
    messages: { 'common.close': 'Close' },
  }), /不兼容/)
  assert.throws(() => validateLocalePack({
    locale: 'zh-CN',
    name: '替换中文',
    agentLensLocaleVersion: 1,
    messages: { 'common.close': '关闭' },
  }), /不允许覆盖/)
})
