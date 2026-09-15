import assert from 'node:assert/strict'
import test from 'node:test'
import {
  importCustomMarkdownTheme,
  MarkdownThemeImportError,
  readCustomMarkdownThemes,
  removeCustomMarkdownTheme,
  scopedCustomMarkdownCss,
} from './markdown-theme-registry'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem(key: string) { return values.get(key) ?? null },
    setItem(key: string, value: string) { values.set(key, value) },
  }
}

test('自定义 Markdown 皮肤可导入、覆盖同名文件并移除', async () => {
  const previousStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  try {
    const first = await importCustomMarkdownTheme(new File(['#write { color: red; }'], 'Paper.css', { type: 'text/css' }))
    const updated = await importCustomMarkdownTheme(new File(['#write { color: blue; }'], 'Paper.css', { type: 'text/css' }))
    assert.equal(first.id, 'custom:paper')
    assert.equal(updated.id, first.id)
    assert.equal(readCustomMarkdownThemes().length, 1)
    assert.match(scopedCustomMarkdownCss(updated), /@scope \(\.markdown\[data-markdown-theme="custom:paper"\]\)/)
    assert.match(scopedCustomMarkdownCss(updated), /:scope \{ color: blue; \}/)
    removeCustomMarkdownTheme(updated.id)
    assert.deepEqual(readCustomMarkdownThemes(), [])
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('自定义 Markdown 皮肤拒绝外部资源和逃逸作用域的 CSS', async () => {
  const previousStorage = globalThis.localStorage
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  try {
    await assert.rejects(
      importCustomMarkdownTheme(new File(['@import "remote.css";'], 'remote.css', { type: 'text/css' })),
      (error: unknown) => error instanceof MarkdownThemeImportError && error.code === 'unsupported-css',
    )
    await assert.rejects(
      importCustomMarkdownTheme(new File(['} body { display: none; } .x {'], 'escape.css', { type: 'text/css' })),
      (error: unknown) => error instanceof MarkdownThemeImportError && error.code === 'unsupported-css',
    )
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previousStorage })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
