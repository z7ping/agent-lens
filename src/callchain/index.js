/**
 * callchain/index.js - 调用链模块
 */

import { getToolType, getToolColor, formatDuration, formatTime, escapeHtml, truncate } from '../config.js';
import { extractSessions } from '../utils.js';
import { renderMarkdownInline, renderMarkdownMessage } from '../markdown.mjs';

/** 记录当前展开的 session ID */
let expandedSessionIds = new Set();

/** 轮次工具调用懒加载缓存（roundId → {nodes, sourceColor}），折叠时不在 DOM 中渲染详情 */
const roundToolsCache = new Map();

/** AI 长文本折叠缓存（bubbleId → 完整文本） */
const assistantTextCache = new Map();

/** AI 气泡折叠阈值 */
const AI_MAX_LINES = 10;
const AI_MAX_CHARS = 600;

// ─── 来源标签 & 颜色映射（共享给会话卡片和轮次头） ───────────────

const sourceLabels = {
  'claude-code': 'Claude CLI', 'hermes': 'Hermes', 'codex': 'Codex',
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

  // 重新渲染时清空懒加载缓存（旧轮次 id 已随 DOM 失效）
  roundToolsCache.clear();
  assistantTextCache.clear();

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
      projectCwd: s.project_cwd || '',
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

  // 渲染后恢复当前列表中仍然存在的展开状态
  let restoredSessionCount = 0;
  for (const sessionId of expandedSessionIds) {
    const card = container.querySelector(`.session-card[data-session-id="${sessionId}"]`);
    if (card) {
      const body = card.querySelector('.session-body');
      const arrow = card.querySelector('.session-arrow');
      if (body) {
        body.classList.remove('hidden');
        if (arrow) arrow.style.transform = 'rotate(90deg)';
        restoredSessionCount++;
      }
    }
  }

  // 切换来源/项目后旧 Session 可能已不在当前列表；此时仍应展开并加载第一条。
  if (restoredSessionCount === 0 && sessions.length > 0) {
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

  // 项目名（优先使用 project_name，回退到 project_key；hash 形态视为未知项目）
  const projectName = formatProjectName(session.projectName || session.project || '');
  const projectCwd = session.projectCwd || session.cwd || '';
  const projectCwdLabel = formatWorkdir(projectCwd);
  // 副标题分两层：第一层 时间 + 项目，第二层 路径 + 平均耗时
  const subtitlePrimary = [timeRange, projectName ? `项目 ${projectName}` : ''].filter(Boolean).join(' · ');
  const subtitleMeta = [projectCwdLabel, avgDur ? `平均 ${formatDuration(avgDur)}` : ''].filter(Boolean).join(' · ');

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
        <div class="session-subtitle" title="${escapeHtml(projectCwd || [subtitlePrimary, subtitleMeta].filter(Boolean).join(' · '))}">${escapeHtml(subtitlePrimary || '等待调用详情')}</div>
        <div class="session-subtitle-meta">${escapeHtml(subtitleMeta)}</div>
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
         data-source="${escapeHtml(session.source)}"
         data-has-error="${hasError ? 'true' : 'false'}">
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
  const isError = isErrorCall(call);
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
  const evidenceBadge = renderEvidenceBadge(call);

  // 结构化详情面板
  const detailContent = renderCallDetail(call, sourceColor);

  return `
    <div class="${itemClass}" data-call-type="${type}" data-call-error="${isError ? 'true' : 'false'}">
    <div class="call-row" style="padding-left:${16 + depth * 20}px" onclick="toggleCallDetail(this)">
      <span class="tool-badge ${type}">${escapeHtml(toolName)}</span>
      <span class="call-main">
        <span class="call-preview">${preview}</span>
        ${outputSnippet ? `<span class="call-output">${escapeHtml(outputSnippet)}</span>` : ''}
      </span>
      <span class="call-meta">
        ${evidenceBadge}
        <span class="call-duration">${duration}</span>
        ${statusBadge}
      </span>
    </div>
    <div class="call-detail hidden">${detailContent}</div>
    </div>
  `;}

const evidenceLabels = {
  runtime_hook: '运行时捕获',
  native_log: '原生日志',
  local_database: '原生数据库',
  cli_diagnostic: 'CLI 诊断',
  static_scan: '静态发现',
  inference: '推断',
  legacy_import: '历史数据',
};

function renderEvidenceBadge(item) {
  const method = item?.capture_method || 'legacy_import';
  const visibility = item?.visibility || 'captured';
  const label = visibility === 'unobservable' ? '不可观察'
    : visibility === 'inferred' ? '推断'
      : visibility === 'discovered' ? '静态发现'
        : (evidenceLabels[method] || '已捕获');
  const title = [label, item?.confidence ? `可信度：${item.confidence}` : '', item?.missing_reason || ''].filter(Boolean).join('；');
  return `<span class="evidence-badge ${escapeHtml(visibility)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

const lifecycleLabels = {
  session_start: ['会话开始', '◉'],
  session_end: ['会话结束', '○'],
  user_prompt: ['提交提示词', '↗'],
  permission_request: ['权限请求', '◆'],
  compact_start: ['开始压缩', '⇣'],
  compact_end: ['压缩完成', '⇡'],
  branch_summary: ['分支摘要', '⑂'],
  model_change: ['模型切换', '↻'],
  thinking_level_change: ['思考级别', '≋'],
  agent_settled: ['运行稳定', '✓'],
  agent_start: ['子 Agent 启动', '◇'],
  agent_stop: ['子 Agent 停止', '◈'],
  turn_stop: ['Turn 完成', '✓'],
  context_discovery: ['上下文发现', 'i'],
  tool_use: ['工具开始', '›'],
  tool_result: ['工具完成', '·'],
  tool_error: ['工具失败', '!'],
};

const primaryLifecycleTypes = new Set([
  'session_start', 'session_end', 'user_prompt', 'permission_request',
  'compact_start', 'compact_end', 'agent_start', 'agent_stop', 'turn_stop',
  'context_discovery', 'branch_summary', 'model_change', 'thinking_level_change',
  'agent_settled',
]);

function getLifecycleAttributes(item) {
  if (item?.attributes && typeof item.attributes === 'object') return item.attributes;
  if (!item?.attributes_json) return {};
  try { return JSON.parse(item.attributes_json); } catch (_) { return {}; }
}

function shortNativeId(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-5)}` : text;
}

function lifecycleSummary(item, attributes) {
  const eventType = item.event_type || item.role;
  if (eventType === 'user_prompt') {
    if (!item.content && String(item.capture_policy || '').startsWith('off')) return '提示词正文采集已关闭';
    return item.content ? truncate(String(item.content).replace(/\s+/g, ' '), 180) : '来源未提供提示词正文';
  }
  if (eventType === 'permission_request') {
    return [item.tool_name || '未知工具', '等待用户或 Codex 正常审批流程'].join(' · ');
  }
  if (eventType === 'session_start') return `启动方式：${attributes.start_source || '未知'}`;
  if (eventType === 'context_discovery') {
    const scope = attributes.scope === 'global' ? '全局' : '项目';
    return `${scope} · ${attributes.file_name || '指令文件'}${attributes.truncated ? ' · 已按上限截断' : ''}`;
  }
  if (eventType === 'session_end') return `结束原因：${attributes.lifecycle_reason || '来源未说明'}`;
  if (eventType === 'compact_start' || eventType === 'compact_end') {
    const trigger = attributes.compact_trigger || attributes.compact_reason;
    const label = trigger === 'auto' || trigger === 'threshold' ? '自动'
      : trigger === 'manual' ? '手动'
        : trigger === 'overflow' ? '溢出恢复' : '来源未说明';
    const tokens = attributes.tokens_before != null ? ` · 压缩前 ${attributes.tokens_before} tokens` : '';
    return `触发方式：${label}${tokens}`;
  }
  if (eventType === 'branch_summary') return item.content ? truncate(String(item.content).replace(/\s+/g, ' '), 180) : '来源记录了分支摘要，但正文未采集';
  if (eventType === 'model_change') return `模型：${[attributes.provider, attributes.model].filter(Boolean).join('/') || '来源未说明'}`;
  if (eventType === 'thinking_level_change') return `级别：${attributes.thinking_level || '来源未说明'}；不采集 thinking 正文`;
  if (eventType === 'agent_settled') return '本轮底层运行、自动重试、压缩和排队后续均已稳定';
  if (eventType === 'agent_start') return `类型：${attributes.agent_type || '未提供'}`;
  if (eventType === 'agent_stop') {
    const prefix = attributes.agent_type ? `${attributes.agent_type} · ` : '';
    return `${prefix}${item.content ? truncate(String(item.content).replace(/\s+/g, ' '), 180) : '未提供最后回复'}`;
  }
  if (eventType === 'turn_stop') {
    return item.content ? '来源提供了最终回复' : '来源未提供最终回复';
  }
  if (eventType === 'tool_result' || eventType === 'tool_error') {
    return `${item.tool_name || '未知工具'}${item.duration_ms != null ? ` · ${formatDuration(item.duration_ms)}` : ''}`;
  }
  return '';
}

function renderEvidenceBadges(items) {
  const seen = new Set();
  return (items || []).map(item => {
    const key = [item?.capture_method, item?.visibility, item?.confidence].join(':');
    if (seen.has(key)) return '';
    seen.add(key);
    return renderEvidenceBadge(item);
  }).join('');
}

function renderFlowEvent(item) {
  const eventType = item.event_type || item.role || 'event';
  const [label, icon] = lifecycleLabels[eventType] || [eventType, '·'];
  const attributes = getLifecycleAttributes(item);
  const summary = lifecycleSummary(item, attributes);
  const meta = [];
  if (item.agent_id) meta.push(`Agent ${shortNativeId(item.agent_id)}`);
  if (attributes.model) meta.push(attributes.model);
  if (attributes.permission_mode) meta.push(`权限 ${attributes.permission_mode}`);

  return `
    <div class="flow-event ${escapeHtml(eventType)}">
      <span class="flow-marker">${escapeHtml(icon)}</span>
      <div class="flow-event-body">
        <div class="flow-event-line">
          <strong>${escapeHtml(label)}</strong>
          ${summary ? `<span class="flow-event-summary">${renderMarkdownInline(summary)}</span>` : ''}
          <span class="flow-event-meta">${escapeHtml(formatTime(item.timestamp || item.ts))}</span>
          ${renderEvidenceBadge(item)}
        </div>
        ${meta.length ? `<div class="flow-event-tags">${meta.map(value => `<span>${escapeHtml(value)}</span>`).join('')}</div>` : ''}
        ${item.missing_reason ? `<div class="flow-event-missing">${escapeHtml(item.missing_reason)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderThinkingSignal(item) {
  const attributes = getLifecycleAttributes(item);
  if (!attributes.thinking_present) return '';
  const count = Number(attributes.thinking_blocks || 0);
  const detail = count > 0 ? `${count} 个来源可见块` : '来源记录了 thinking';
  return `
    <div class="flow-event thinking-observed">
      <span class="flow-marker">◌</span>
      <div class="flow-event-body">
        <div class="flow-event-line">
          <strong>思考</strong>
          <span class="flow-event-summary">${escapeHtml(detail)} · 正文未采集</span>
          <span class="flow-event-meta">${escapeHtml(formatTime(item.timestamp || item.ts))}</span>
          ${renderEvidenceBadge(item)}
        </div>
      </div>
    </div>
  `;
}

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

function normalizedMessageText(item) {
  return extractUserText(item).replace(/\s+/g, ' ').trim();
}

function buildExecutionFlow(calls) {
  const sessionBefore = [];
  const sessionAfter = [];
  const rounds = [];
  const roundsByTurn = new Map();
  let currentRound = null;
  let pendingBetween = [];

  const createRound = (turnId = null) => {
    const round = {
      turnId,
      userMessage: null,
      userEvidence: [],
      beforeEvents: pendingBetween,
      events: [],
      completed: false,
    };
    pendingBetween = [];
    rounds.push(round);
    if (turnId) roundsByTurn.set(turnId, round);
    return round;
  };

  for (const item of calls || []) {
    const eventType = item.event_type || item.role;
    if (eventType === 'session_start' || eventType === 'context_discovery') {
      if (!currentRound) sessionBefore.push(item);
      else if (currentRound.completed) pendingBetween.push(item);
      else currentRound.events.push(item);
      continue;
    }
    if (eventType === 'session_end') {
      sessionAfter.push(...pendingBetween);
      pendingBetween = [];
      sessionAfter.push(item);
      continue;
    }

    const isUser = item.role === 'user' || eventType === 'user_prompt';
    if (isUser) {
      const text = normalizedMessageText(item);
      let round = item.turn_id ? roundsByTurn.get(item.turn_id) : null;
      if (!round && currentRound && !currentRound.completed) {
        const currentText = normalizedMessageText(currentRound.userMessage || {});
        if ((text && currentText === text) || !currentText) round = currentRound;
      }
      if (!round) round = createRound(item.turn_id || null);
      if (item.turn_id && !round.turnId) {
        round.turnId = item.turn_id;
        roundsByTurn.set(item.turn_id, round);
      }
      round.userEvidence.push(item);
      if (!round.userMessage || (item.role === 'user' && round.userMessage.role !== 'user')) {
        round.userMessage = item;
      }
      currentRound = round;
      continue;
    }

    let round = item.turn_id ? roundsByTurn.get(item.turn_id) : null;
    if (!round && item.turn_id) round = createRound(item.turn_id);
    if (!round && currentRound?.completed) {
      pendingBetween.push(item);
      continue;
    }
    if (!round) round = currentRound;
    if (!round && item.role === 'assistant') round = createRound();
    if (!round) {
      sessionBefore.push(item);
      continue;
    }
    round.events.push(item);
    if (eventType === 'turn_stop') round.completed = true;
    currentRound = round;
  }

  sessionAfter.unshift(...pendingBetween);
  return { sessionBefore, rounds, sessionAfter };
}

function messagesEquivalent(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  return shorterLength >= 12 && (left.includes(right) || right.includes(left));
}

function renderChatMessage(role, item, roundIndex, eventIndex, evidenceItems = [item]) {
  const text = role === 'assistant' ? extractAssistantText(item) : extractUserText(item);
  if (!text) return '';
  const id = `flow-${role}-${roundIndex}-${eventIndex}-${Math.random().toString(36).slice(2, 8)}`;
  const label = role === 'assistant' ? 'AI' : '用户';
  const bubble = role === 'assistant'
    ? renderAssistantBubble(id, [text])
    : `<div class="chat-bubble user">${renderMarkdownMessage(id, text)}</div>`;
  return `
    <div class="chat-message ${role}">
      <div class="chat-meta">${label} · 第 ${roundIndex + 1} 轮 ${renderEvidenceBadges(evidenceItems)}</div>
      ${bubble}
    </div>
  `;
}

function renderToolGroup(toolCalls, roundIndex, groupIndex, sourceColor) {
  if (!toolCalls.length) return '';
  const toolsId = `round-tools-${roundIndex}-${groupIndex}-${Math.random().toString(36).slice(2, 8)}`;
  const tree = buildTree(toolCalls);
  roundToolsCache.set(toolsId, { nodes: tree, sourceColor });
  const errorCount = toolCalls.filter(isErrorCall).length;
  const duration = toolCalls.reduce((sum, call) => sum + (Number(call.duration_ms) || 0), 0);
  const typeBadges = getToolTypeCounts(toolCalls, 3)
    .map(t => `<span class="tool-type-badge ${t.type}">${t.type} ${t.count}</span>`)
    .join('');
  return `
    <div class="round-tools flow-tools collapsed" id="${toolsId}" data-errors-only="false">
      <button class="round-tools-toggle" type="button" onclick="toggleRoundTools('${toolsId}')">
        <span class="round-tools-title">
          <span class="round-tools-chevron">›</span>
          工具执行 · ${toolCalls.length} 次
          <span class="round-tools-summary">${errorCount ? `${errorCount} 次失败` : '全部成功'}${duration ? ` · ${formatDuration(duration)}` : ''}</span>
        </span>
        <span class="round-tools-badges">
          ${typeBadges}
          ${errorCount ? `<span class="tool-error-badge">${errorCount} 错误</span>` : ''}
        </span>
      </button>
      <div class="round-tools-body">
        <label class="round-tools-filter" onclick="event.stopPropagation()">
          <input type="checkbox" onchange="toggleRoundErrorFilter('${toolsId}', this.checked)">
          只显示报错调用
        </label>
        <div class="round-calls"></div>
      </div>
    </div>
  `;
}

function renderFlowItems(events, roundIndex, sourceColor) {
  const parts = [];
  let toolBatch = [];
  let toolGroupIndex = 0;
  const resultCallIds = new Set(events
    .filter(item => item.role === 'tool_result' || item.role === 'tool_error')
    .map(item => item.call_id || item.tool_use_id)
    .filter(Boolean));
  const assistantTexts = new Set(events
    .filter(item => item.role === 'assistant')
    .map(normalizedMessageText)
    .filter(Boolean));
  const renderedAssistantTexts = new Set();

  const flushTools = () => {
    if (!toolBatch.length) return;
    parts.push(renderToolGroup(toolBatch, roundIndex, toolGroupIndex++, sourceColor));
    toolBatch = [];
  };

  events.forEach((item, eventIndex) => {
    const eventType = item.event_type || item.role;
    if (item.role === 'tool_result' || item.role === 'tool_error') {
      toolBatch.push(item);
      return;
    }
    if (item.role === 'tool_use' && resultCallIds.has(item.call_id || item.tool_use_id)) return;
    flushTools();

    if (item.role === 'assistant') {
      const thinking = renderThinkingSignal(item);
      if (thinking) parts.push(thinking);
      const textKey = normalizedMessageText(item);
      if (textKey && !renderedAssistantTexts.has(textKey)) {
        parts.push(renderChatMessage('assistant', item, roundIndex, eventIndex));
        renderedAssistantTexts.add(textKey);
      }
      return;
    }

    if (eventType === 'turn_stop') {
      const textKey = normalizedMessageText(item);
      const duplicatesAssistant = [...assistantTexts, ...renderedAssistantTexts]
        .some(candidate => messagesEquivalent(textKey, candidate));
      if (textKey && !duplicatesAssistant) {
        parts.push(renderChatMessage('assistant', item, roundIndex, eventIndex));
        renderedAssistantTexts.add(textKey);
      }
      parts.push(renderFlowEvent(item));
      return;
    }

    if (eventType === 'user_prompt') return;
    if (eventType === 'tool_use' || primaryLifecycleTypes.has(eventType)) {
      parts.push(renderFlowEvent(item));
    }
  });
  flushTools();
  return parts.join('');
}

/** 渲染单个完整 Turn：用户气泡 → 可观察事件/工具 → AI 气泡。 */
function renderRound(round, index, sourceColor = '', defaultExpanded = false) {
  const toolCalls = round.events.filter(item => item.role === 'tool_result' || item.role === 'tool_error');
  const errorCount = toolCalls.filter(isErrorCall).length;
  const hasError = errorCount > 0;
  const hasSlow = toolCalls.some(call => (call.duration_ms || 0) > 5000);
  const summaryMeta = [];
  if (toolCalls.length) summaryMeta.push(`<span class="round-summary-pill">${toolCalls.length} 工具</span>`);
  if (hasError) summaryMeta.push(`<span class="round-summary-pill error">${errorCount} 错误</span>`);
  if (hasSlow) summaryMeta.push(`<span class="round-summary-pill slow">慢</span>`);
  const timestamps = [round.userMessage, ...round.events]
    .map(item => new Date(item?.timestamp || item?.ts || '').getTime())
    .filter(Number.isFinite);
  const roundDuration = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;

  const userBubble = round.userMessage
    ? renderChatMessage('user', round.userMessage, index, 0, round.userEvidence)
    : '';
  const flowItems = renderFlowItems(round.events, index, sourceColor);
  const content = userBubble || flowItems
    ? `<div class="round-content"><div class="turn-flow">${userBubble}${flowItems}</div></div>`
    : '';
  const toolTypes = Array.from(new Set(toolCalls.map(call => getToolType(call.tool_name || '')).filter(Boolean)));
  const expandedDefault = defaultExpanded || hasError;

  return `
    <div class="round-block${expandedDefault ? '' : ' collapsed'}" data-tool-types="${escapeHtml(toolTypes.join(' '))}" data-has-error="${hasError ? 'true' : 'false'}" data-has-slow="${hasSlow ? 'true' : 'false'}">
      <div class="round-summary" onclick="toggleRound(this)">
        <span class="round-summary-chevron">›</span>
        <span class="round-summary-title">第 ${index + 1} 轮</span>
        ${roundDuration ? `<span class="round-summary-duration">${formatDuration(roundDuration)}</span>` : ''}
        ${summaryMeta.length ? `<span class="round-summary-meta">${summaryMeta.join('')}</span>` : ''}
      </div>
      ${content}
    </div>
  `;
}

function renderSessionFlow(items, position) {
  const events = (items || [])
    .filter(item => primaryLifecycleTypes.has(item.event_type || item.role))
    .map(renderFlowEvent)
    .join('');
  if (!events) return '';
  return `<div class="session-flow-events ${position}">${events}</div>`;
}

window.toggleRound = function (summaryEl) {
  const block = summaryEl.closest('.round-block');
  if (block) block.classList.toggle('collapsed');
};

/** 判断调用是否为报错 */
function isErrorCall(call) {
  return call.error === true
    || call.success === false
    || call.success === 0
    || call.error_message
    || (call.exit_code != null && call.exit_code !== 0);
}

/** 工具调用类型分布（按次数排序，返回 [{type, count}]） */
function getToolTypeCounts(calls, limit = 3) {
  const byType = {};
  for (const c of calls) {
    const t = getToolType(c.tool_name || '');
    byType[t] = (byType[t] || 0) + 1;
  }
  return Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([type, count]) => ({ type, count }));
}

/** 渲染 AI 气泡（长文本默认折叠，底部渐隐遮罩 + 展开全文按钮） */
function renderAssistantBubble(id, texts) {
  const fullText = texts.join('\n\n');
  const lines = fullText.split('\n');
  const needsCollapse = lines.length > AI_MAX_LINES || fullText.length > AI_MAX_CHARS;
  if (!needsCollapse) {
    return `<div class="chat-bubble assistant">${renderMarkdownMessage(id, fullText)}</div>`;
  }
  assistantTextCache.set(id, fullText);
  const preview = lines.length > AI_MAX_LINES
    ? lines.slice(0, AI_MAX_LINES).join('\n')
    : fullText.slice(0, AI_MAX_CHARS);
  const hint = lines.length > AI_MAX_LINES ? `还有 ${lines.length - AI_MAX_LINES} 行` : '内容较长';
  return `
    <div class="chat-bubble assistant collapsed" id="${id}">
      <div class="assistant-preview">${renderMarkdownMessage(`${id}-preview`, preview)}</div>
      <span class="assistant-fade"></span>
      <button type="button" class="assistant-expand" onclick="expandAssistant('${id}')" title="${hint}">展开全文 ↓</button>
    </div>
  `;
}

window.expandAssistant = function (id) {
  const bubble = document.getElementById(id);
  if (!bubble || !assistantTextCache.has(id)) return;
  bubble.innerHTML = renderMarkdownMessage(`${id}-full`, assistantTextCache.get(id));
  bubble.classList.remove('collapsed');
  assistantTextCache.delete(id);
};

window.toggleMarkdownSource = function (id) {
  const message = document.getElementById(id);
  if (!message) return;
  const rendered = message.querySelector('.markdown-rendered');
  const source = message.querySelector('.markdown-source');
  const button = message.querySelector('.markdown-toggle');
  const showingSource = message.dataset.view === 'source';
  message.dataset.view = showingSource ? 'markdown' : 'source';
  rendered?.classList.toggle('hidden', !showingSource);
  source?.classList.toggle('hidden', showingSource);
  if (button) button.textContent = showingSource ? '源码' : '渲染';
};

/** 轮次导航：按错误 / 慢调用 / 最近一轮过滤 */
window.setRoundNav = function (btn, mode) {
  const container = btn.closest('.session-body')?.querySelector('.rounds-container');
  if (!container) return;
  container.dataset.nav = mode;
  btn.closest('.round-nav')?.querySelectorAll('.round-nav-btn').forEach(b => {
    b.classList.toggle('active', b === btn);
  });
};

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

function formatWorkdir(cwd) {
  if (!cwd) return '';
  const normalized = String(cwd).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `${parts.at(-2)}/${parts.at(-1)}`;
}

/** 项目名：MD5 hash 形态（如 hermes 历史项目）显示为 未知项目 · 短hash */
function formatProjectName(name) {
  if (!name) return '';
  const s = String(name);
  if (/^[0-9a-f]{8,32}$/i.test(s)) return `未知项目 · ${s.slice(0, 6)}`;
  return s;
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
  const executionFlow = buildExecutionFlow(calls);
  const { sessionBefore, rounds, sessionAfter } = executionFlow;
  // 无轮次数据（全是 tool 记录，无 user）,退化到平铺
  if (rounds.length === 0) {
    const flatCalls = calls.filter(call => ['tool_use', 'tool_result', 'tool_error'].includes(call.role));
    const tree = buildTree(flatCalls);
    const context = renderSessionFlow([...sessionBefore, ...sessionAfter], 'standalone');
    return `<div class="task-execution-flow">${context}${tree.map((call, i) => renderCall(call, i, '', sourceColor)).join('')}</div>`;
  }

  // 轮次导航（长会话快速定位：全部 / 有错误 / 慢调用 / 最近一轮），带数量反馈
  const errorRounds = rounds.filter(round => round.events.some(item =>
    (item.role === 'tool_result' || item.role === 'tool_error') && isErrorCall(item)
  )).length;
  const slowRounds = rounds.filter(round => round.events.some(item =>
    (item.role === 'tool_result' || item.role === 'tool_error') && (item.duration_ms || 0) > 5000
  )).length;
  const nav = rounds.length > 1 ? `
    <div class="round-nav">
      <span class="round-nav-label">轮次</span>
      <button class="round-nav-btn active" data-roundnav="all" onclick="setRoundNav(this, 'all')">全部轮次 ${rounds.length}</button>
      <button class="round-nav-btn" data-roundnav="error" onclick="setRoundNav(this, 'error')">有错误 ${errorRounds}</button>
      <button class="round-nav-btn" data-roundnav="slow" onclick="setRoundNav(this, 'slow')">慢调用 ${slowRounds}</button>
      <button class="round-nav-btn" data-roundnav="last" onclick="setRoundNav(this, 'last')">最近一轮</button>
    </div>
  ` : '';

  const roundsHtml = `
    <div class="task-execution-flow">
      ${renderSessionFlow(sessionBefore, 'before')}
      <div class="rounds-container" data-nav="all">${rounds.map((round, i) => `${renderSessionFlow(round.beforeEvents, 'between')}${renderRound(round, i, sourceColor, true)}`).join('')}</div>
      ${renderSessionFlow(sessionAfter, 'after')}
    </div>
  `;

  return nav + roundsHtml;
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
  const wasCollapsed = panel.classList.contains('collapsed');
  panel.classList.toggle('collapsed');
  if (wasCollapsed) {
    // 首次展开时懒加载详情（折叠时 DOM 无详情文本）
    const callsEl = panel.querySelector('.round-calls');
    if (callsEl && !callsEl.dataset.loaded && roundToolsCache.has(roundId)) {
      const { nodes, sourceColor } = roundToolsCache.get(roundId);
      callsEl.innerHTML = nodes.map((call, i) => renderCall(call, i, '', sourceColor)).join('');
      callsEl.dataset.loaded = '1';
      if (window.applyToolFilters) window.applyToolFilters(callsEl);
    }
  }
};

window.toggleRoundErrorFilter = function (roundId, checked) {
  const panel = document.getElementById(roundId);
  if (!panel) return;
  panel.dataset.errorsOnly = checked ? 'true' : 'false';
};
