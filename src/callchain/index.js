/**
 * callchain/index.js - 调用链模块
 */

import { getToolType, getToolColor, formatDuration, formatTime, escapeHtml, truncate } from '../config.js';
import { extractSessions } from '../utils.js';

/** 记录当前展开的 session ID */
let expandedSessionIds = new Set();

// ─── 来源标签 & 颜色映射（共享给会话卡片和轮次头） ───────────────

const sourceLabels = {
  'claude-code': 'Claude', 'hermes': 'Hermes', 'codex': 'Codex',
  'opencode': 'OpenCode', 'cursor': 'Cursor', 'pi': 'Pi', 'openclaw': 'OpenClaw',
};

const sourceColors = {
  'claude-code': { light: '#3b82f6', dark: '#60a5fa' },
  'hermes': { light: '#a855f7', dark: '#c084fc' },
  'codex': { light: '#22c55e', dark: '#4ade80' },
  'opencode': { light: '#f97316', dark: '#fb923c' },
  'cursor': { light: '#06b6d4', dark: '#22d3ee' },
  'pi': { light: '#f43f5e', dark: '#fb7185' },
  'openclaw': { light: '#14b8a6', dark: '#2dd4bf' },
};

const sourceBorderColors = {
  'claude-code': 'border-l-blue-500 dark:border-l-blue-400',
  'hermes': 'border-l-purple-500 dark:border-l-purple-400',
  'codex': 'border-l-green-500 dark:border-l-green-400',
  'opencode': 'border-l-orange-500 dark:border-l-orange-400',
  'cursor': 'border-l-cyan-500 dark:border-l-cyan-400',
  'pi': 'border-l-rose-500 dark:border-l-rose-400',
  'openclaw': 'border-l-teal-500 dark:border-l-teal-400',
};

/** 渲染调用链 */
export function renderCallChain(data) {
  const container = document.getElementById('sessionContainer');
  const emptyState = document.getElementById('emptyState');
  if (!container) return;

  // 渲染前保存当前展开状态
  expandedSessionIds = new Set(
    Array.from(container.querySelectorAll('.session-card'))
      .filter(card => {
        const body = card.querySelector('.session-body');
        return body && !body.classList.contains('hidden');
      })
      .map(card => card.dataset.sessionId)
  );

  // 兼容两种格式：原始 log 条目 or session 摘要
  let sessions;
  if (data.length > 0 && data[0].session_id && data[0].tool_count !== undefined) {
    // 已经是 session 摘要格式
    sessions = data.map(s => ({
      id: s.session_id,
      project: s.project_key || '',
      projectName: s.project_name || s.project_key || '',
      source: s.source || '',
      startTime: s.start_time,
      endTime: s.end_time,
      calls: [],
      tools: new Set(),
      errors: s.error_count || 0,
      totalDuration: s.total_duration_ms || 0,
      toolCount: s.tool_count || 0,
    }));
  } else {
    sessions = extractSessions(data);
  }

  if (sessions.length === 0) {
    container.innerHTML = '';
    emptyState?.classList.remove('hidden');
    return;
  }

  emptyState?.classList.add('hidden');
  container.innerHTML = sessions.map(renderSession).join('');

  // 渲染后恢复展开状态
  for (const sessionId of expandedSessionIds) {
    const card = container.querySelector(`.session-card[data-session-id="${sessionId}"]`);
    if (card) {
      const body = card.querySelector('.session-body');
      const arrow = card.querySelector('.session-arrow');
      if (body) {
        body.classList.remove('hidden');
        if (arrow) arrow.style.transform = 'rotate(90deg)';
      }
    }
  }

  // 默认展开第一个会话（如果没有已展开的会话）
  if (expandedSessionIds.size === 0 && sessions.length > 0) {
    const firstCard = container.querySelector('.session-card');
    if (firstCard) {
      const body = firstCard.querySelector('.session-body');
      const arrow = firstCard.querySelector('.session-arrow');
      if (body) {
        body.classList.remove('hidden');
        if (arrow) arrow.style.transform = 'rotate(90deg)';
        // 触发加载调用详情
        if (!body.dataset.loaded && window.loadSessionCalls) {
          window.loadSessionCalls(firstCard);
        }
      }
    }
  }
}

/** 根据字符串生成稳定颜色（用于 session ID） */
function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

/** 短 session ID */
function shortId(sid) {
  if (!sid) return '—';
  if (sid.length <= 12) return sid;
  // 格式：20260709_112643_xxx → 20260709 1126
  const parts = sid.split('_');
  if (parts.length >= 2 && parts[0].length === 8) {
    return parts[0] + ' ' + parts[1].slice(0, 4);
  }
  return sid.slice(0, 12) + '…';
}

/** 格式化时间范围 */
function formatTimeRange(start, end) {
  if (!start) return '';
  const s = new Date(start);
  const fmtDate = (d) => d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
  const fmtTime = (d) => d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (!end) return `${fmtDate(s)} ${fmtTime(s)}`;
  const e = new Date(end);
  if (fmtDate(s) === fmtDate(e)) {
    return `${fmtDate(s)} ${fmtTime(s)}~${fmtTime(e)}`;
  }
  return `${fmtDate(s)} ${fmtTime(s)}~${fmtDate(e)} ${fmtTime(e)}`;
}

function getSessionStatus(session) {
  if ((session.errors || 0) > 0) return { label: '有错误', cls: 'error' };
  if ((session.totalDuration || 0) > 5000) return { label: '偏慢', cls: 'slow' };
  return { label: '成功', cls: 'success' };
}

function summarizeCalls(calls) {
  const summary = {
    total: calls.length,
    errors: 0,
    slow: 0,
    byType: {},
    slowest: null,
  };

  for (const call of calls) {
    const type = getToolType(call.tool_name || call.name || '');
    summary.byType[type] = (summary.byType[type] || 0) + 1;
    if (call.success === 0 || call.success === false || call.error || call.error_message) summary.errors++;
    if ((call.duration_ms || 0) > 5000) summary.slow++;
    if (!summary.slowest || (call.duration_ms || 0) > (summary.slowest.duration_ms || 0)) {
      summary.slowest = call;
    }
  }

  return summary;
}

function renderMetric(label, value, tone = '') {
  return `
    <span class="session-metric ${tone}">
      <span class="session-metric-value">${escapeHtml(String(value))}</span>
      <span class="session-metric-label">${escapeHtml(label)}</span>
    </span>
  `;
}

/** 构建树形结构 */
function buildTree(calls) {
  if (!calls || calls.length === 0) return [];

  // 按 seq 升序排序（API 可能返回倒序），无 seq 的放最后保持原序
  const sorted = [...calls].sort((a, b) => {
    if (a.seq == null && b.seq == null) return 0;
    if (a.seq == null) return 1;
    if (b.seq == null) return -1;
    return a.seq - b.seq;
  });

  // 按 seq 建索引（用排序后的引用）
  const seqMap = new Map();
  for (const c of sorted) {
    if (c.seq != null) seqMap.set(c.seq, { ...c, children: [] });
  }

  // 按 seq 升序遍历建立父子关系（父节点一定先于子节点被处理）
  const roots = [];
  for (const c of sorted) {
    const node = c.seq != null ? seqMap.get(c.seq) : null;
    if (!node) { roots.push({ ...c, children: [], _depth: 0 }); continue; }
    const parent = c.parent_seq != null ? seqMap.get(c.parent_seq) : null;
    if (parent) {
      node._depth = (parent._depth || 0) + 1;
      parent.children.push(node);
    } else {
      node._depth = 0;
      roots.push(node);
    }
  }

  // 扁平化（保留树序）
  const flat = [];
  function walk(nodes) {
    for (const n of nodes) {
      flat.push(n);
      if (n.children.length) walk(n.children);
    }
  }
  walk(roots);

  // 如果树构建失败（无 seq），回退到原始顺序
  if (flat.length !== calls.length) {
    return calls.map(c => ({ ...c, children: [], _depth: 0 }));
  }
  return flat;
}

/** 渲染单个会话卡片 */
function renderSession(session) {
  const toolCount = session.toolCount || session.tools?.size || 0;
  const duration = formatDuration(session.totalDuration);
  const timeRange = formatTimeRange(session.startTime, session.endTime);
  const hasError = session.errors > 0;
  const okCount = (session.toolCount || session.calls?.length || 0) - session.errors;
  const isActive = (Date.now() - new Date(session.endTime).getTime()) < 5 * 60 * 1000;
  const color = hashColor(session.id);
  const avgDur = (session.toolCount || session.calls?.length || 0) > 0 ? session.totalDuration / (session.toolCount || session.calls.length) : 0;
  const status = getSessionStatus(session);

  // 来源标签样式
  const source = session.source || '';
  const sourceLabel = sourceLabels[source] || source;
  const sourceColor = ({
    'claude-code': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'hermes': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    'codex': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'opencode': 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    'cursor': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    'pi': 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    'openclaw': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  })[source] || 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400';

  // 项目名（优先使用 project_name，回退到 project_key）
  const projectName = session.projectName || session.project || '';
  const sessionSubtitle = [
    timeRange,
    projectName ? `项目 ${projectName}` : '',
    avgDur ? `平均 ${formatDuration(avgDur)}` : '',
  ].filter(Boolean).join(' · ');

  const header = `
    <div class="session-header" onclick="toggleSession(event.currentTarget)">
      <div class="session-title-block">
        <div class="session-title-row">
          <svg class="session-arrow w-3 h-3 text-neutral-400 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
          <span class="session-id" style="color:${color}" title="会话ID: ${escapeHtml(session.id)}">${escapeHtml(shortId(session.id))}</span>
          ${sourceLabel ? `<span class="text-xs px-1.5 py-0.5 rounded-md font-medium ${sourceColor}">${escapeHtml(sourceLabel)}</span>` : ''}
          ${source === 'hermes' ? '<span title="包含对话记录">💬</span>' : ''}
          <span class="session-status ${status.cls}">${status.label}</span>
        </div>
        <div class="session-subtitle">${escapeHtml(sessionSubtitle || '等待调用详情')}</div>
      </div>
      <div class="session-metrics">
        ${renderMetric('调用', toolCount)}
        ${renderMetric('成功', Math.max(okCount, 0), 'success')}
        ${hasError ? renderMetric('错误', session.errors, 'error') : ''}
        ${renderMetric('总耗时', duration)}
      </div>
    </div>
  `;

  // 来源颜色 hex 值（用于左边线 inline style）
  const sourceHex = (sourceColors[source] || {}).light || '';

  // 树形渲染调用
  const tree = buildTree(session.calls);
  const calls = tree.map((call, i) => renderCall(call, i, session.project, sourceHex)).join('');

  const borderClass = sourceBorderColors[source] || 'border-l-neutral-300 dark:border-l-neutral-600';

  return `
    <div class="session-card ${borderClass}${isActive ? ' active-session' : ''}"
         id="session-${escapeHtml(session.id)}"
         data-session-id="${escapeHtml(session.id)}"
         data-source="${escapeHtml(session.source)}">
      ${header}
      <div class="session-body hidden">
        ${calls.length > 0 ? calls : '<div class="text-center py-4 text-neutral-400 text-sm">加载中...</div>'}
      </div>
    </div>
  `;
}

/** JSON 语法高亮（逐字符 token 化，避免正则误匹配） */
function highlightJson(json) {
  const out = [];
  let i = 0;
  const len = json.length;

  while (i < len) {
    const ch = json[i];

    // 字符串
    if (ch === '"') {
      let j = i + 1;
      while (j < len && json[j] !== '"') {
        if (json[j] === '\\') j++;
        j++;
      }
      j++;
      const raw = json.slice(i, j);
      const escaped = escapeHtml(raw);
      // 后面紧跟 `:` 的是 key
      let k = j;
      while (k < len && json[k] === ' ') k++;
      if (json[k] === ':') {
        out.push(`<span class="jk">${escaped}</span>`);
      } else {
        out.push(`<span class="js">${escaped}</span>`);
      }
      i = j;
      continue;
    }

    // 数字
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (json[j] === '-') j++;
      while (j < len && json[j] >= '0' && json[j] <= '9') j++;
      if (j < len && json[j] === '.') {
        j++;
        while (j < len && json[j] >= '0' && json[j] <= '9') j++;
      }
      out.push(`<span class="jn">${escapeHtml(json.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // 布尔/null
    if (json.slice(i, i + 4) === 'true') {
      out.push('<span class="jb">true</span>');
      i += 4; continue;
    }
    if (json.slice(i, i + 5) === 'false') {
      out.push('<span class="jb">false</span>');
      i += 5; continue;
    }
    if (json.slice(i, i + 4) === 'null') {
      out.push('<span class="jb">null</span>');
      i += 4; continue;
    }

    // 其他字符
    out.push(escapeHtml(ch));
    i++;
  }

  return out.join('');
}

/** 渲染单个调用行 */
function renderCall(call, index, projectPath, sourceColor = '') {
  const toolName = call.tool_name || call.name || '未知';
  const type = getToolType(toolName);
  const duration = formatDuration(call.duration_ms);
  const isError = call.error === true || call.success === false || call.success === 0 || (call.exit_code != null && call.exit_code !== 0);
  const isSlow = call.duration_ms > 5000;
  const depth = call._depth || 0;
  const exitCode = call.exit_code != null ? call.exit_code : (call.success === 0 ? 1 : 0);

  // 状态类
  let itemClass = 'call-item type-' + type;
  if (isError) itemClass += ' error';
  else if (isSlow) itemClass += ' slow';

  // 类型特定预览
  const input = parseToolInput(call);
  const preview = getTypePreview(toolName, input, call, projectPath);
  const outputSnippet = getOutputContent(call).substring(0, 120);

  const statusBadge = isError
    ? `<span class="call-status error">失败 ${exitCode}</span>`
    : isSlow
      ? `<span class="call-status slow">偏慢</span>`
      : `<span class="call-status success">成功</span>`;

  // 结构化详情面板
  const detailContent = renderCallDetail(call, sourceColor);

  return `
    <div class="${itemClass}" data-call-error="${isError ? 'true' : 'false'}">
    <div class="call-row" style="padding-left:${16 + depth * 20}px" onclick="toggleCallDetail(this)">
      <span class="tool-badge ${type}">${escapeHtml(toolName)}</span>
      <span class="call-main">
        <span class="call-preview">${preview}</span>
        ${outputSnippet ? `<span class="call-output">${escapeHtml(outputSnippet)}</span>` : ''}
      </span>
      <span class="call-meta">
        <span class="call-duration">${duration}</span>
        ${statusBadge}
      </span>
    </div>
    <div class="call-detail hidden">${detailContent}</div>
    </div>
  `;}

/** 类型特定行内预览 */
function getTypePreview(toolName, input, call, projectPath) {
  const type = getToolType(toolName);
  if (type === 'bash') {
    const cmd = input.command || input.cmd || input.raw || '';
    if (cmd) return `<span class="preview-cmd">❯ ${escapeHtml(truncate(cmd, 80))}</span>`;
    const raw = call.tool_input || '';
    if (raw) return `<span class="preview-cmd">❯ ${escapeHtml(truncate(String(raw), 80))}</span>`;
  }
  if (type === 'read') {
    const path = input.path || input.file_path || input.filePath || '';
    if (path) return `<span class="preview-file">📄 ${escapeHtml(truncate(path, 60))}</span>`;
  }
  if (type === 'write') {
    const path = input.path || input.file_path || input.filePath || '';
    if (path) return `<span class="preview-file">✏️ ${escapeHtml(truncate(path, 60))}</span>`;
  }
  if (type === 'mcp') {
    const target = input.tool || input.mcp_server || input.query || input.prompt || input.path || input.raw || '';
    if (target) return `<span class="preview-fallback">${escapeHtml(truncate(String(target), 80))}</span>`;
  }
  // 通用回退：显示输入摘要
  const inputStr = Object.keys(input).length > 0 ? JSON.stringify(input) : '';
  if (inputStr) return `<span class="preview-fallback">${escapeHtml(truncate(inputStr, 80))}</span>`;
  return '';
}

/** 获取调用输入摘要（供 session 卡片预览用） */
function getCallSummary(call) {
  const input = parseToolInput(call);
  if (!input || Object.keys(input).length === 0) {
    const raw = call.tool_input || '';
    if (raw && typeof raw === 'string') return raw;
    return '';
  }

  // Bash 命令
  if (input.command) return input.command;
  if (input.cmd) return input.cmd;

  // 文件路径
  if (input.path || input.file_path || input.filePath) return input.path || input.file_path || input.filePath;

  // 搜索
  if (input.pattern) return `grep: ${input.pattern}`;
  if (input.query) return input.query;

  // 描述
  if (input.description) return input.description;

  // 回退
  const vals = Object.values(input).filter(v => typeof v === 'string');
  if (vals.length) return vals[0];
  return JSON.stringify(input).slice(0, 100);
}

/** 获取文件路径（省略共同前缀） */
function getFilePath(call, projectPath) {
  const input = parseToolInput(call);
  const rawPath = input.path || input.file_path || input.filePath || input.new_path || input.old_path;
  if (!rawPath || typeof rawPath !== 'string') return null;

  const full = rawPath;
  // 省略项目路径前缀
  let short = full;
  if (projectPath && full.startsWith(projectPath)) {
    short = full.slice(projectPath.length).replace(/^\//, '');
  } else {
    // 省略 home 目录前缀
    const homeMatch = full.match(/^\/home\/[^/]+/);
    if (homeMatch) {
      short = '~' + full.slice(homeMatch[0].length);
    }
  }
  // 如果还是太长，省略中间部分
  if (short.length > 50) {
    const parts = short.split('/');
    if (parts.length > 3) {
      short = parts[0] + '/…/' + parts.slice(-2).join('/');
    }
  }

  return { full, short };
}

/** 按轮次分组（role=user 为分隔） */
function groupByRounds(calls) {
  const rounds = [];
  let currentRound = null;

  for (const call of calls) {
    if (call.role === 'user') {
      currentRound = { userMessage: call, toolCalls: [], assistantMessages: [] };
      rounds.push(currentRound);
    } else if (call.role === 'assistant') {
      if (currentRound) {
        currentRound.assistantMessages.push(call);
      } else {
        // 没有前置 user 消息，作为首个轮次
        currentRound = { userMessage: null, toolCalls: [], assistantMessages: [call] };
        rounds.push(currentRound);
      }
    } else if (call.role === 'tool_result' || call.role === 'tool_error') {
      if (!currentRound) {
        currentRound = { userMessage: null, toolCalls: [], assistantMessages: [] };
        rounds.push(currentRound);
      }
      currentRound.toolCalls.push(call);
    }
  }

  return rounds;
}

/** 渲染单个轮次 */
function renderRound(round, index, sourceColor = '') {
  const parts = [];

  // 从轮次内的工具调用推断来源（取第一个有 source 的）
  const roundSource = round.toolCalls.find(c => c.source)?.source
    || round.assistantMessages.find(m => m.source)?.source
    || '';

  const roundId = `round-tools-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const workdir = getRoundWorkdir(round);
  const workdirLabel = workdir ? formatWorkdir(workdir) : '';

  parts.push(`<div class="round-conversation">`);

  if (workdirLabel) {
    parts.push(`
      <div class="round-workdir" title="${escapeHtml(workdir)}">
        <span>工作目录</span>
        <code>${escapeHtml(workdirLabel)}</code>
      </div>
    `);
  }

  // 用户气泡
  const userContent = round.userMessage
    ? extractUserText(round.userMessage)
    : '';
  parts.push(`
    <div class="chat-message user">
      <div class="chat-meta">用户 · 第 ${index + 1} 轮</div>
      <div class="chat-bubble user">
        ${userContent ? escapeHtml(userContent) : '<span class="muted">无用户消息</span>'}
      </div>
    </div>
  `);

  // AI 气泡
  const assistantTexts = [];
  for (const msg of round.assistantMessages) {
    const text = extractAssistantText(msg);
    if (text) assistantTexts.push(text);
  }
  if (assistantTexts.length) {
    parts.push(`
      <div class="chat-message assistant">
        <div class="chat-meta">AI</div>
        <div class="chat-bubble assistant">${escapeHtml(assistantTexts.join('\n\n'))}</div>
      </div>
    `);
  }

  parts.push(`</div>`);

  // 工具调用（默认折叠）
  if (round.toolCalls.length > 0) {
    const tree = buildTree(round.toolCalls);
    const rendered = tree.map((call, i) => renderCall(call, i, '', sourceColor)).join('');
    const errorCount = round.toolCalls.filter(call => (
      call.error === true
      || call.success === false
      || call.success === 0
      || call.error_message
      || (call.exit_code != null && call.exit_code !== 0)
    )).length;
    parts.push(`
      <div class="round-tools collapsed" id="${roundId}" data-errors-only="false">
        <button class="round-tools-toggle" type="button" onclick="toggleRoundTools('${roundId}')">
          <span class="round-tools-title">
            <span class="round-tools-chevron">›</span>
            工具调用详情
          </span>
          <span class="round-tools-summary">${round.toolCalls.length} 次调用${errorCount ? ` · ${errorCount} 个报错` : ''}</span>
        </button>
        <div class="round-tools-body">
          <label class="round-tools-filter" onclick="event.stopPropagation()">
            <input type="checkbox" onchange="toggleRoundErrorFilter('${roundId}', this.checked)">
            只显示报错调用
          </label>
          <div class="round-calls">${rendered}</div>
        </div>
      </div>
    `);
  }

  return parts.join('');
}

/** 从 user 消息中提取文本 */
function extractUserText(call) {
  if (call.content) {
    if (typeof call.content === 'string') {
      try {
        const parsed = JSON.parse(call.content);
        return parsed.text || parsed.content || call.content;
      } catch { return call.content; }
    }
    if (typeof call.content === 'object') {
      return call.content.text || call.content.content || JSON.stringify(call.content);
    }
  }
  return '';
}

/** 从 assistant 消息中提取文本 */
function extractAssistantText(call) {
  return extractUserText(call);
}

function getRoundWorkdir(round) {
  const candidates = [
    round.userMessage,
    ...round.assistantMessages,
    ...round.toolCalls,
  ];
  const match = candidates.find(call => call?.project_cwd || call?.cwd);
  return match?.project_cwd || match?.cwd || '';
}

function formatWorkdir(cwd) {
  if (!cwd) return '';
  const normalized = String(cwd).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

/** 解析 tool_input（兼容字符串、对象、双重 JSON） */
function parseToolInput(call) {
  if (!call) return {};
  if (call.input_summary && typeof call.input_summary === 'object' && Object.keys(call.input_summary).length > 0) {
    return call.input_summary;
  }
  const raw = call.tool_input || call.input || call.arguments;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    // 处理双重序列化：'{"command":"npm"}' → 再解析一次
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch { return { raw: parsed }; }
    }
    return parsed;
  } catch { return { raw }; }
}

/** 获取输出内容 */
function getOutputContent(call) {
  if (call.output_snippet) return call.output_snippet;
  if (call.content) {
    if (typeof call.content === 'string') return call.content;
    try { return JSON.stringify(call.content).slice(0, 500); } catch { return ''; }
  }
  return '';
}

/** 渲染结构化调用详情（替代原始 JSON） */
function renderCallDetail(call, sourceColor = '') {
  const toolName = call.tool_name || '';
  const input = parseToolInput(call);
  const output = getOutputContent(call);
  const ts = call.timestamp ? new Date(call.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
  const exitCode = call.exit_code != null ? call.exit_code : (call.success === 0 ? 1 : 0);
  const isError = call.success === 0 || call.error || call.error_message || (call.exit_code != null && call.exit_code !== 0);
  const hasOutput = !!output;
  const hasError = !!call.error_message || isError;

  let parts = [];

  // ── 头部信息条 ──
  const statusBadge = isError
    ? `<span class="detail-status-badge error">✘ Exit ${exitCode}</span>`
    : `<span class="detail-status-badge success">✔ Exit ${exitCode}</span>`;

  parts.push(`
    <div class="detail-header">
      ${statusBadge}
      <span class="detail-duration">⚡ ${formatDuration(call.duration_ms)}</span>
      <span class="detail-time">${escapeHtml(ts)}</span>
      ${call.source ? `<span class="detail-source">${escapeHtml(call.source)}</span>` : ''}
    </div>
  `);

  // ── Bash ──
  if (toolName === 'bash') {
    const cmd = input.command || input.cmd || input.raw || '';
    if (cmd) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">命令</div>
          <pre class="detail-code select-all">${escapeHtml(cmd)}</pre>
        </div>
      `);
    }
    if (hasOutput) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">输出</div>
          <pre class="detail-code max-h-32">${escapeHtml(output)}</pre>
        </div>
      `);
    }
    if (hasError && call.error_message) {
      parts.push(`
        <div class="detail-section error">
          <div class="detail-label">错误</div>
          <pre class="detail-code">${escapeHtml(call.error_message)}</pre>
          ${call.error_type ? `<div class="detail-error-type">类型: ${escapeHtml(call.error_type)}</div>` : ''}
        </div>
      `);
    }
  }

  // ── Read ──
  else if (toolName === 'read') {
    const path = input.path || input.file_path || input.filePath || '';
    if (path) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">📄 文件</div>
          <div class="detail-path select-all">${escapeHtml(path)}</div>
        </div>
      `);
    }
    if (hasOutput) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">内容</div>
          <pre class="detail-code max-h-40">${escapeHtml(output)}</pre>
        </div>
      `);
    }
  }

  // ── Write / Edit ──
  else if (toolName === 'write' || toolName === 'edit') {
    const path = input.path || input.file_path || input.filePath || input.new_path || '';
    if (path) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">✏️ 文件</div>
          <div class="detail-path select-all">${escapeHtml(path)}</div>
        </div>
      `);
    }
    const content = input.content || input.new_content || '';
    if (content) {
      const preview = typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content).slice(0, 500);
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">${input.old_content ? '变更内容' : '内容'}</div>
          <pre class="detail-code max-h-32">${escapeHtml(preview)}${content.length > 500 ? '…' : ''}</pre>
        </div>
      `);
    }
    if (hasOutput) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">输出</div>
          <pre class="detail-code max-h-20">${escapeHtml(output)}</pre>
        </div>
      `);
    }
  }

  // ── 通用回退 ──
  else {
    const inputStr = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '';
    if (inputStr) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">输入</div>
          <pre class="detail-code max-h-32">${escapeHtml(inputStr)}</pre>
        </div>
      `);
    }
    if (hasOutput) {
      parts.push(`
        <div class="detail-section">
          <div class="detail-label">输出</div>
          <pre class="detail-code max-h-32">${escapeHtml(output)}</pre>
        </div>
      `);
    }
    if (hasError && call.error_message) {
      parts.push(`
        <div class="detail-section error">
          <div class="detail-label">错误</div>
          <pre class="detail-code">${escapeHtml(call.error_message)}</pre>
        </div>
      `);
    }
  }

  // ── 底部：查看原始数据 ──
  const rawJson = highlightJson(JSON.stringify(call, null, 2));
  parts.push(`
    <div class="detail-raw-toggle">
      <button onclick="event.stopPropagation();this.nextElementSibling.classList.toggle('hidden')">📋 查看原始数据</button>
      <pre class="hidden detail-raw-json">${rawJson}</pre>
    </div>
  `);

  return `<div class="call-detail-inner">${parts.join('')}</div>`;
}

/** 渲染调用列表（供外部懒加载使用） */
export function renderCallChainCalls(calls) {
  if (!calls || calls.length === 0) return '';

  // 从调用数据中提取来源颜色
  const src = calls[0]?.source || '';
  const sourceColor = (sourceColors[src] || {}).light || '';

  const rounds = groupByRounds(calls);
  const summary = summarizeCalls(calls.filter(c => c.role === 'tool_result' || c.role === 'tool_error' || c.tool_name));
  const topTypes = Object.entries(summary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${type} ${count}`)
    .join(' · ');
  const slowest = summary.slowest
    ? `${summary.slowest.tool_name || '工具'} ${formatDuration(summary.slowest.duration_ms)}`
    : '—';
  const overview = `
    <div class="execution-overview">
      <div>
        <div class="overview-label">执行概览</div>
        <div class="overview-main">${summary.total} 次工具调用${topTypes ? ` · ${escapeHtml(topTypes)}` : ''}</div>
      </div>
      <div class="overview-pills">
        <span class="overview-pill ${summary.errors ? 'error' : 'success'}">错误 ${summary.errors}</span>
        <span class="overview-pill ${summary.slow ? 'slow' : ''}">慢调用 ${summary.slow}</span>
        <span class="overview-pill">最慢 ${escapeHtml(slowest)}</span>
      </div>
    </div>
  `;

  // 无轮次数据（全是 tool 记录，无 user）,退化到平铺
  if (rounds.length === 0) {
    const tree = buildTree(calls);
    return overview + tree.map((call, i) => renderCall(call, i, '', sourceColor)).join('');
  }

  return overview + rounds.map((round, i) => renderRound(round, i, sourceColor)).join('');
}

/** 切换调用行的详情面板 */
window.toggleCallDetail = function (rowEl) {
  const detail = rowEl.parentElement.querySelector('.call-detail');
  if (!detail) return;
  detail.classList.toggle('hidden');
};

window.toggleRoundTools = function (roundId) {
  const panel = document.getElementById(roundId);
  if (!panel) return;
  panel.classList.toggle('collapsed');
};

window.toggleRoundErrorFilter = function (roundId, checked) {
  const panel = document.getElementById(roundId);
  if (!panel) return;
  panel.dataset.errorsOnly = checked ? 'true' : 'false';
};
