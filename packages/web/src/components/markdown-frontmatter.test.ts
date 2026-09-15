import assert from 'node:assert/strict'
import test from 'node:test'
import { splitMarkdownFrontmatter } from './markdown-frontmatter'

test('Markdown frontmatter separates YAML metadata from body', () => {
  const result = splitMarkdownFrontmatter(`---
name: adapt-ghostty-theme-to-pi
description: |
  Adapt a Ghostty terminal theme.
  Keep semantic colors.
tags:
  - pi
  - theme
---
# adapt-ghostty-theme-to-pi

Body
`)
  assert.equal(result.body, '# adapt-ghostty-theme-to-pi\n\nBody\n')
  assert.deepEqual(result.frontmatter?.entries, [
    { key: 'name', value: 'adapt-ghostty-theme-to-pi' },
    { key: 'description', value: 'Adapt a Ghostty terminal theme.\nKeep semantic colors.\n' },
    { key: 'tags', value: '- pi\n- theme' },
  ])
})

test('Markdown without a complete leading frontmatter block stays untouched', () => {
  const text = '# title\n\n---\nbody'
  assert.deepEqual(splitMarkdownFrontmatter(text), { body: text, frontmatter: null })

  const unclosed = '---\nname: skill\n# body'
  assert.deepEqual(splitMarkdownFrontmatter(unclosed), { body: unclosed, frontmatter: null })
})

test('Malformed YAML is removed from Markdown body and degrades to raw metadata', () => {
  const result = splitMarkdownFrontmatter('---\nname: [broken\n---\n# body\n')
  assert.equal(result.body, '# body\n')
  assert.equal(result.frontmatter?.raw, 'name: [broken')
  assert.equal(result.frontmatter?.entries.length, 0)
  assert.ok(result.frontmatter?.error)
})
