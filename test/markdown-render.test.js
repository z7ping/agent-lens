const test = require('node:test');
const assert = require('node:assert/strict');

async function loadMarkdown() {
  return import('../src/markdown.mjs');
}

test('renders common markdown blocks as safe HTML', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const html = renderMarkdown('# 标题\n\n- **重点** `code`\n- [链接](https://example.com)\n\n```js\nconst x = 1 < 2;\n```');

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer">链接<\/a>/);
  assert.match(html, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);
});

test('escapes unsafe markdown HTML and javascript links', async () => {
  const { renderMarkdown } = await loadMarkdown();
  const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))');

  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('renders a source toggle wrapper in markdown mode by default', async () => {
  const { renderMarkdownMessage } = await loadMarkdown();
  const html = renderMarkdownMessage('msg-1', '**你好**');

  assert.match(html, /data-view="markdown"/);
  assert.match(html, /<strong>你好<\/strong>/);
  assert.match(html, /markdown-source hidden/);
  assert.match(html, /toggleMarkdownSource\('msg-1'\)/);
});

test('renders one-line markdown summaries without block wrappers', async () => {
  const { renderMarkdownInline } = await loadMarkdown();
  const html = renderMarkdownInline('摘要 **重点** `cmd` [文档](https://example.com)');

  assert.equal(html, '摘要 <strong>重点</strong> <code>cmd</code> <a href="https://example.com" target="_blank" rel="noreferrer">文档</a>');
});
