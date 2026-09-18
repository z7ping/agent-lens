import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const service = readFileSync(new URL('./service.ts', import.meta.url), 'utf8')

test('Pi Worker message fork follows native before-message semantics', () => {
  assert.match(worker, /Object\.hasOwn\(input, 'branchFromEntryId'\)/)
  assert.match(worker, /leafId === null[\s\S]{0,500}SessionManager\.create\(input\.cwd, sessionDir\)/)
  assert.match(worker, /fresh\.newSession\(\{ parentSession: input\.sessionPath \}\)/)
  assert.match(worker, /manager\.createBranchedSession\(leafId\)/)
})

test('Pi Edit from here uses native navigateTree and never rewrites JSONL in service code', () => {
  assert.match(worker, /session\.navigateTree\(value\.entryId\)/)
  assert.match(service, /runtime\.handle\.navigateTree\(target\.entryId\)/)
  assert.doesNotMatch(service, /writeFile|appendFile|truncate|unlink/)
})

test('Pi message actions require persisted user entries and an idle Runtime', () => {
  assert.match(service, /row\.type !== 'message' \|\| message\.role !== 'user'/)
  assert.match(service, /snapshot\.state\.isStreaming/)
  assert.match(service, /branchFromEntryId:\s*target\.parentId/)
})
