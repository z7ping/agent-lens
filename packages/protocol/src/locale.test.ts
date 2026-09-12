import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_LENS_LOCALE_API_VERSION,
  parseLocalePackDto,
} from './locale'

test('Locale Pack accepts declarative nested string messages', () => {
  const pack = parseLocalePackDto({
    localeApiVersion: AGENT_LENS_LOCALE_API_VERSION,
    locale: 'en-us',
    name: 'Test English',
    compatibility: { agentLensMajor: 1 },
    messages: {
      common: {
        ok: 'OK',
      },
    },
  })

  assert.equal(pack.locale, 'en-US')
  assert.equal((pack.messages.common as Record<string, string>).ok, 'OK')
})

test('Locale Pack rejects executable and prototype-shaped values', () => {
  assert.throws(() => parseLocalePackDto({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Unsafe',
    compatibility: { agentLensMajor: 1 },
    messages: { common: { action: () => 'run' } },
  }))

  const messages = Object.create(null) as Record<string, unknown>
  Object.defineProperty(messages, '__proto__', { value: 'blocked', enumerable: true })
  assert.throws(() => parseLocalePackDto({
    localeApiVersion: 1,
    locale: 'en-US',
    name: 'Unsafe',
    compatibility: { agentLensMajor: 1 },
    messages,
  }))
})
