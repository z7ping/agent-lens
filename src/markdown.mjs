const BLOCK_TOKEN_PREFIX = '\u0000MD_BLOCK_';

export function escapeMarkdownHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeMarkdownHtml(value).replace(/`/g, '&#96;');
}

function isSafeUrl(url) {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(url);
}

export function renderMarkdownInline(text) {
  const blocks = [];
  let html = escapeMarkdownHtml(text);

  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const token = `${BLOCK_TOKEN_PREFIX}${blocks.length}\u0000`;
    blocks.push(`<code>${code}</code>`);
    return token;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const cleanUrl = String(url || '').trim();
    if (!isSafeUrl(cleanUrl)) return label;
    return `<a href="${escapeAttr(cleanUrl)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return html.replace(new RegExp(`${BLOCK_TOKEN_PREFIX}(\\d+)\\u0000`, 'g'), (_, index) => blocks[Number(index)] || '');
}

function flushParagraph(out, paragraph) {
  if (paragraph.length) {
    out.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  }
}

function flushList(out, list) {
  if (list.length) {
    out.push(`<ul>${list.map(item => `<li>${renderMarkdownInline(item)}</li>`).join('')}</ul>`);
    list.length = 0;
  }
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const paragraph = [];
  const list = [];
  let inCode = false;
  let codeLang = '';
  let codeLines = [];

  for (const line of lines) {
    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code${codeLang ? ` class="language-${escapeAttr(codeLang)}"` : ''}>${escapeMarkdownHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        flushParagraph(out, paragraph);
        flushList(out, list);
        inCode = true;
        codeLang = fence[1] || '';
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph(out, paragraph);
      flushList(out, list);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(out, paragraph);
      flushList(out, list);
      const level = heading[1].length;
      out.push(`<h${level}>${renderMarkdownInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph(out, paragraph);
      flushList(out, list);
      out.push(`<blockquote>${renderMarkdownInline(quote[1].trim())}</blockquote>`);
      continue;
    }

    const listItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (listItem) {
      flushParagraph(out, paragraph);
      list.push(listItem[1].trim());
      continue;
    }

    flushList(out, list);
    paragraph.push(line.trim());
  }

  if (inCode) {
    out.push(`<pre><code${codeLang ? ` class="language-${escapeAttr(codeLang)}"` : ''}>${escapeMarkdownHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushParagraph(out, paragraph);
  flushList(out, list);

  return out.join('');
}

export function renderMarkdownMessage(id, text) {
  return `
    <div class="markdown-message" id="${escapeAttr(id)}" data-view="markdown">
      <div class="markdown-toolbar">
        <button type="button" class="markdown-toggle" onclick="toggleMarkdownSource('${escapeAttr(id)}')">源码</button>
      </div>
      <div class="markdown-rendered">${renderMarkdown(text)}</div>
      <pre class="markdown-source hidden">${escapeMarkdownHtml(text)}</pre>
    </div>
  `;
}
