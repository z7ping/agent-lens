import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const repositories = readFileSync(new URL('./repositories.ts', import.meta.url), 'utf8')

test('SourceSession generic list remains unbounded unless caller explicitly supplies limit', () => {
  assert.match(repositories, /const hasLimit = Number\.isInteger\(requestedLimit\)/)
  assert.match(repositories, /\$\{hasLimit \? 'LIMIT \?' : ''\}/)
  assert.match(repositories, /if \(hasLimit\) params\.push/)
  assert.doesNotMatch(repositories, /:\s*64\s*\n\s*params\.push\(limit\)/)
})
