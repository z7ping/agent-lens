import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLocalFileTarget } from './LocalFileLink'

test('parses Windows local file markdown targets with line and column', () => {
  assert.deepEqual(
    parseLocalFileTarget('F:/01-ai-gen-workspaces/agent-lens/packages/web/src/task-turn-rail.css:39'),
    {
      path: 'F:/01-ai-gen-workspaces/agent-lens/packages/web/src/task-turn-rail.css',
      line: 39,
    },
  )
  assert.deepEqual(
    parseLocalFileTarget('C:\\workspace\\demo\\src\\index.ts:12:7'),
    {
      path: 'C:\\workspace\\demo\\src\\index.ts',
      line: 12,
      column: 7,
    },
  )
})

test('parses POSIX and file URL targets', () => {
  assert.deepEqual(parseLocalFileTarget('/home/user/project/src/app.ts#L21C3'), {
    path: '/home/user/project/src/app.ts',
    line: 21,
    column: 3,
  })
  assert.deepEqual(parseLocalFileTarget('file:///C:/workspace/demo/src/app.ts#L8'), {
    path: 'C:/workspace/demo/src/app.ts',
    line: 8,
  })
})

test('does not treat normal web links as local files', () => {
  assert.equal(parseLocalFileTarget('https://example.com/app.css:39'), null)
  assert.equal(parseLocalFileTarget('/review/session-1'), null)
  assert.equal(parseLocalFileTarget('docs/readme.md'), null)
})
