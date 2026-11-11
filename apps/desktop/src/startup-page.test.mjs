import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import { test } from 'node:test'
import { startupPage, startupBackgroundColor, startupBackgroundColors } from './startup-page.mjs'

const html = decodeURIComponent(startupPage.slice(startupPage.indexOf(',') + 1))

test('splash defaults to the Web light background and follows system dark mode', () => {
  assert.equal(startupBackgroundColor(false), '#f6f7f9')
  assert.equal(startupBackgroundColor(true), '#101216')
  assert.match(html, /color-scheme: light/)
  assert.match(html, /@media \(prefers-color-scheme: dark\)/)
  for (const color of Object.values(startupBackgroundColors)) {
    assert.ok(html.includes(color), `missing startup background ${color}`)
  }
  assert.match(html, /background:var\(--startup-bg\)/)
})

test('startup language falls back to English and keeps Chinese for zh locale', () => {
  const scriptSource = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(scriptSource)
  const script = new Script(scriptSource)
  for (const [language, expected] of [
    ['C', false], ['en-US', false], ['fr-FR', false], ['', false],
    ['zh_CN', true], ['zh-TW', true],
  ]) {
    const nodes = {
      'startup-title': { textContent: 'AgentLens' },
      'startup-message': { textContent: 'Starting the local runtime.' },
    }
    const document = {
      documentElement: { lang: 'en-US' },
      title: 'AgentLens',
      getElementById: id => nodes[id],
    }
    script.runInNewContext({ navigator: { language }, document })
    assert.equal(document.documentElement.lang, expected ? 'zh-CN' : 'en-US', language)
    assert.equal(document.title.includes('智能体透镜'), expected, language)
  }
})
