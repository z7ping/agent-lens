import assert from 'node:assert/strict'
import test from 'node:test'
import type { LocaleMessageValueDto } from '@agent-lens/protocol'
import { officialEnglishLocalePack } from './official-en-US'
import { officialChineseLocalePack } from './official-zh-CN'

function flatten(
  value: LocaleMessageValueDto | Record<string, LocaleMessageValueDto>,
  prefix = '',
  output = new Map<string, string>(),
): Map<string, string> {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof item === 'string') output.set(path, item)
    else flatten(item, path, output)
  }
  return output
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.-]+)\s*}}/g)]
    .map(match => match[1]!)
    .sort()
}

test('built-in en-US covers every zh-CN product message key', () => {
  const zh = flatten(officialChineseLocalePack.messages)
  const en = flatten(officialEnglishLocalePack.messages)

  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort())
  assert.ok(en.size > 1_000)
})

test('built-in en-US preserves interpolation contracts for every key', () => {
  const zh = flatten(officialChineseLocalePack.messages)
  const en = flatten(officialEnglishLocalePack.messages)

  for (const [key, source] of zh) {
    assert.deepEqual(
      interpolationTokens(en.get(key) ?? ''),
      interpolationTokens(source),
      `interpolation tokens differ for ${key}`,
    )
  }
})

test('built-in en-US contains no Chinese product copy', () => {
  const en = flatten(officialEnglishLocalePack.messages)
  for (const [key, value] of en) {
    assert.doesNotMatch(value, /[\u3400-\u9fff]/, `Chinese copy remains in en-US: ${key}`)
  }
})
