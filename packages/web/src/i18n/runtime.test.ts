import assert from 'node:assert/strict'
import test from 'node:test'
import { agentLensI18n, initializeI18n, readLocalePreference, setLocale, systemProductLocale } from './runtime'
import { localePack, resetLocaleRegistry } from './registry'

const frenchPack = {
  localeApiVersion: 1,
  locale: 'fr-FR',
  name: 'French',
  compatibility: { agentLensMajor: 1 },
  messages: { common: { loadingWorkspace: 'Chargement' } },
}

test('社区语言请求未完成时内置语言仍可启动，随后恢复已保存语言', async t => {
  resetLocaleRegistry()
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'fr-FR', setItem: () => undefined },
  })
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    resetLocaleRegistry()
  })
  let release!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve }))
  await initializeI18n()
  assert.equal(agentLensI18n.language, systemProductLocale(typeof navigator === 'undefined' ? undefined : navigator.language))
  assert.equal(localePack('fr-FR'), null)
  release(Response.json({ items: [frenchPack] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agentLensI18n.language, 'fr-FR')
  assert.equal(agentLensI18n.t('common:loadingWorkspace'), 'Chargement')
})

test('后台语言发现不覆盖用户主动切换', async t => {
  resetLocaleRegistry()
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => 'fr-FR', setItem: () => undefined },
  })
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    resetLocaleRegistry()
  })
  let release!: (response: Response) => void
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { release = resolve }))
  await initializeI18n()
  await setLocale('en-US')
  release(Response.json({ items: [frenchPack] }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(agentLensI18n.language, 'en-US')
  assert.ok(agentLensI18n.hasResourceBundle('fr-FR', 'common'))
})

test('语言发现超时中止请求，页面继续使用内置语言', async t => {
  resetLocaleRegistry()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', (_input: unknown, init: RequestInit) => {
    signal = init.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('超时', 'AbortError')), { once: true })
    })
  })
  await initializeI18n()
  const initialLanguage = agentLensI18n.language
  assert.ok(['zh-CN', 'en-US'].includes(initialLanguage))
  assert.equal(signal?.aborted, false)
  t.mock.timers.tick(5_000)
  await Promise.resolve()
  assert.equal(signal?.aborted, true)
  assert.equal(agentLensI18n.language, initialLanguage)
})

test('首次启动按系统语言选择；C/POSIX/未知回退英文', () => {
  for (const input of ['zh-CN', 'zh_TW', 'zh', 'ZH-hans']) {
    assert.equal(systemProductLocale(input), 'zh-CN')
  }
  for (const input of ['en-US', 'fr-FR', 'C', 'POSIX', undefined]) {
    assert.equal(systemProductLocale(input), 'en-US')
  }
})

test('保存的用户选择优先于系统语言', t => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US' } })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => 'zh-CN' },
  })
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
  })
  assert.equal(readLocalePreference(), 'zh-CN')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: { getItem: () => null },
  })
  assert.equal(readLocalePreference(), 'en-US')
})
