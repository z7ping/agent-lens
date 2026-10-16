import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { classifyLocalLink, parseLocalFileTarget } from './LocalFileLink'

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


test('distinguishes Markdown, code, directories, paths, and external links before clicking', () => {
  assert.equal(classifyLocalLink('F:/project/README.md'), 'markdown')
  assert.equal(classifyLocalLink('/home/user/project/README.markdown'), 'markdown')
  assert.equal(classifyLocalLink('C:\\project\\src\\App.tsx:39'), 'code')
  assert.equal(classifyLocalLink('/home/user/project/docs/'), 'directory')
  assert.equal(classifyLocalLink('F:/project/docs', 'directory'), 'directory')
  assert.equal(classifyLocalLink('F:/project/docs'), 'path')
  assert.equal(classifyLocalLink('F:/project/.gitignore', 'file'), 'file')
  assert.equal(classifyLocalLink('https://github.com/z7ping/agent-lens'), 'web')
  assert.equal(classifyLocalLink('docs/README.md'), 'other')
  assert.equal(classifyLocalLink('F:/project/a.md', 'path'), 'path')
})

test('host Markdown file links reuse the common renderer and source toggle', () => {
  const link = readFileSync(new URL('./LocalFileLink.tsx', import.meta.url), 'utf8')
  const markdown = readFileSync(new URL('./MarkdownContent.tsx', import.meta.url), 'utf8')
  const resource = readFileSync(new URL('./LocalResourceReference.tsx', import.meta.url), 'utf8')
  const managed = readFileSync(new URL('./AgentManagedFilesDialog.tsx', import.meta.url), 'utf8')
  assert.match(link, /<MarkdownContent text=\{preview\.content\} frontmatter\/>/)
  assert.match(link, /setView\(isMarkdownFileName\(result\.name\) \? 'rendered' : 'source'\)/)
  assert.match(link, /aria-pressed=\{view === 'rendered'\}/)
  assert.match(link, /aria-pressed=\{view === 'source'\}/)
  assert.match(link, /reason\.status === 409/)
  assert.match(link, /isMarkdownFileName\(preview\.name\)/)
  assert.match(link, /reason\.status === 501/)
  assert.match(resource, /resourceKind=\{kind\}/)
  assert.match(managed, /file-preview-view-toggle/)
  assert.match(markdown, /a: \(\{ node: _node, \.\.\.props \}\) => <LocalFileLink/)
})

test('link icons share the anchor hit area and inherit the link color', () => {
  const link = readFileSync(new URL('./LocalFileLink.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./local-file-preview.css', import.meta.url), 'utf8')
  assert.match(link, /<UiIcon className="markdown-link-type-icon" name=\{icon\} size=\{14\}\/>\{children\}<\/a>/)
  assert.match(styles, /\.markdown-link-type-icon \{[^}]*margin-right: 4px;[^}]*color: inherit;/s)
  assert.match(styles, /\.markdown-external-link \.markdown-link-type-icon \{ margin: 0 0 0 4px; \}/)
  assert.doesNotMatch(styles, /\.markdown-local-file-link\.is-directory \.markdown-link-type-icon/)
})
