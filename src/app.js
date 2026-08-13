/**
 * app.js - 主入口
 */

import { CONFIG, escapeHtml } from './config.js';
import { fetchProjects, fetchSessions, fetchSessionLogs, checkHookStatus, fetchSourceStatus, fetchCapabilities, fetchAppInfo } from './utils.js';
import { renderCallChain } from './callchain/index.js';
import { initDashboard, loadDashboardData } from './dashboard/index.js';
import { initOverview, loadOverview } from './overview/index.js';
import { getExpandAllAction, shouldShowToolType, shouldShowToolTypeSet } from './ui-state.mjs';

// ─── 全局状态 ───────────────────────────────────────
let currentTab = 'callchain';
let currentTool = 'all';
let currentProject = '';
let sortOrder = 'desc'; // 'desc' = 最新在前, 'asc' = 最早在前
let autoRefresh = false;
let refreshTimer = null;
let isDark = false;
let appInfo = null;

// ─── 初始化 ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  initAppInfo();
  initProjects();
  initEventListeners();
  await loadCallChain();
  initDashboard();
  initOverview();
  startAutoRefresh();
  checkStatus();
  updateSourceStatus();
  updateCapabilityMatrix();
});

async function initAppInfo() {
  const el = document.getElementById('appVersion');
  const info = await fetchAppInfo();
  appInfo = info || null;
  if (el) {
    el.textContent = info?.display_version || '';
    el.title = info?.name ? `${info.name} ${info.display_version || ''}` : 'AgentLens 版本';
  }
  const subtitle = document.getElementById('appSubtitle');
  if (subtitle && info?.subtitle) subtitle.textContent = info.subtitle;
  const githubLink = document.getElementById('githubLink');
  if (githubLink && info?.repository_url) githubLink.href = info.repository_url;
  renderChangelog(info?.changelog);
}

function renderChangelog(changelog) {
  const version = document.getElementById('changelogVersion');
  const list = document.getElementById('changelogList');
  if (version) version.textContent = changelog?.current_version || appInfo?.display_version || '当前版本';
  if (!list) return;
  const items = Array.isArray(changelog?.items) ? changelog.items : [];
  list.innerHTML = items.length
    ? items.map(item => `<li>${escapeHtml(String(item))}</li>`).join('')
    : '<li>暂无更新日志摘要</li>';
}

window.openChangelog = function () {
  renderChangelog(appInfo?.changelog);
  document.getElementById('changelogModal')?.classList.remove('hidden');
};

window.closeChangelog = function () {
  document.getElementById('changelogModal')?.classList.add('hidden');
};

// ─── 主题 ───────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('agent-lens-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
    isDark = true;
  }
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    isDark = !isDark;
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('agent-lens-theme', isDark ? 'dark' : 'light');
  });
}

// ─── 项目选择 ───────────────────────────────────────
async function initProjects() {
  const select = document.getElementById('projectSelect');
  if (!select) return;
  select.addEventListener('change', () => {
    currentProject = select.value;
    updateFilterSummary();
    loadCallChain();
    loadDashboardData(currentProject, undefined, currentTool === 'all' ? '' : currentTool);
  });
  await reloadProjectOptions();
}

async function reloadProjectOptions() {
  const select = document.getElementById('projectSelect');
  if (!select) return;
  const data = await fetchProjects(currentTool === 'all' ? '' : currentTool);
  const projects = normalizeProjectOptions(data);
  const previous = currentProject;
  select.innerHTML = '<option value="">全部项目</option>';
  for (const project of projects) {
    const opt = document.createElement('option');
    opt.value = project.project_key;
    opt.textContent = projectLabel(project);
    opt.title = [project.cwd, project.source_label].filter(Boolean).join(' · ');
    select.appendChild(opt);
  }
  const stillAvailable = !previous || projects.some(project => project.project_key === previous);
  currentProject = stillAvailable ? previous : '';
  select.value = currentProject;
}

function normalizeProjectOptions(data) {
  if (Array.isArray(data?.items)) return data.items;
  return Object.entries(data || {}).map(([key, value]) => ({
    project_key: key,
    name: value?.name || key,
    cwd: value?.cwd || '',
    source_label: '',
    session_count: 0,
    tool_count: 0,
  }));
}

function projectLabel(project) {
  const name = project.name || project.project_key || '未知项目';
  const source = project.source_label || '';
  const count = project.session_count ? `${project.session_count} 会话` : '';
  return [name, source, count].filter(Boolean).join(' · ');
}

// ─── 事件监听 ───────────────────────────────────────
function initEventListeners() {
  // 自动刷新
  document.getElementById('autoRefreshBtn')?.addEventListener('click', toggleAutoRefresh);
}

// ─── Tab 切换 ───────────────────────────────────────
window.switchTab = function (tab) {
  currentTab = tab;
  // 更新 tab 按钮样式
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // 显示/隐藏内容
  document.getElementById('tab-callchain')?.classList.toggle('hidden', tab !== 'callchain');
  document.getElementById('tab-callchain')?.classList.toggle('active', tab === 'callchain');
  document.getElementById('tab-dashboard')?.classList.toggle('hidden', tab !== 'dashboard');
  document.getElementById('tab-dashboard')?.classList.toggle('active', tab === 'dashboard');
  document.getElementById('tab-overview')?.classList.toggle('hidden', tab !== 'overview');
  document.getElementById('tab-overview')?.classList.toggle('active', tab === 'overview');
  // 调用链操作区
  document.getElementById('callchainActions')?.classList.toggle('hidden', tab !== 'callchain');
  document.getElementById('toolFilters')?.classList.toggle('hidden', tab !== 'callchain');
  document.getElementById('filterSummary')?.classList.toggle('hidden', tab !== 'callchain');

  // 切换到仪表盘时加载数据（带上当前工具来源过滤）
  if (tab === 'dashboard') {
    loadDashboardData(currentProject, undefined, currentTool === 'all' ? '' : currentTool);
  }
  if (tab === 'overview') {
    loadOverview({ source: currentTool === 'all' ? '' : currentTool });
  }
};

// ─── 来源 Tab 选择 ──────────────────────────────────
window.selectTool = async function (tool) {
  currentTool = tool;
  document.querySelectorAll('.tool-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tool === tool);
  });
  await reloadProjectOptions();
  loadCallChain();
  updateFilterSummary();
  if (currentTab === 'dashboard') {
    loadDashboardData(currentProject, undefined, tool === 'all' ? '' : tool);
  }
  if (currentTab === 'overview') {
    loadOverview({ force: true, source: tool === 'all' ? '' : tool });
  }
};

// ─── 自动刷新 ───────────────────────────────────────
function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefresh) {
    refreshTimer = setInterval(() => {
      if (currentTab === 'callchain') loadCallChain();
    }, CONFIG.REFRESH_INTERVAL);
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

window.toggleAutoRefresh = function () {
  autoRefresh = !autoRefresh;
  const liveDot = document.getElementById('liveDot');
  const liveText = document.getElementById('liveText');
  const liveToggle = document.getElementById('liveToggle');
  if (liveDot) {
    liveDot.className = autoRefresh
      ? 'w-2 h-2 rounded-full bg-success-500 animate-pulse'
      : 'w-2 h-2 rounded-full bg-neutral-400';
  }
  if (liveText) liveText.textContent = autoRefresh ? '自动刷新中' : '自动刷新已暂停';
  if (liveToggle) {
    liveToggle.className = autoRefresh
      ? 'flex items-center gap-1.5 px-2 py-1 rounded-md bg-success-50 dark:bg-success-500/10 text-success-600 dark:text-success-400 font-medium cursor-pointer hover:bg-success-100 dark:hover:bg-success-500/20 transition-colors'
      : 'flex items-center gap-1.5 px-2 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-500 font-medium cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors';
  }
  autoRefresh ? startAutoRefresh() : stopAutoRefresh();
};

window.toggleSort = function () {
  sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
  const btn = document.getElementById('sortBtn');
  if (btn) {
    btn.textContent = sortOrder === 'desc' ? '↓ 最新' : '↑ 最早';
  }
  loadCallChain();
};

// ─── 加载调用链 ─────────────────────────────────────
async function loadCallChain() {
  try {
    const params = new URLSearchParams();
    if (currentTool !== 'all') params.set('source', currentTool);
    if (currentProject) params.set('project', currentProject);
    params.set('sort', sortOrder);
    params.set('limit', '100');

    const res = await fetch(`${CONFIG.API_BASE}/api/sessions?${params}`);
    if (!res.ok) {
      renderCallChain([]);
      return;
    }
    const data = await res.json();
    const sessions = data.items || [];

    renderCallChain(sessions);
    applyFilters();
    updateStatusFromSessions(sessions);
  } catch {
    renderCallChain([]);
  }
}

// ─── 工具类型过滤 ───────────────────────────────────
window.filterTool = function (type) {
  document.querySelectorAll('.filter-chip-sm').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.filter === type);
  });
  applyFilters();
  updateFilterSummary();
};

// ─── 组合过滤（仅工具类型）──────────────────────────
function applyFilters(root = document) {
  const activeTool = document.querySelector('.filter-chip-sm.active')?.dataset.filter || 'all';

  root.querySelectorAll('.round-block[data-tool-types]').forEach(round => {
    const rowTypes = (round.dataset.toolTypes || '').split(/\s+/).filter(Boolean);
    round.style.display = shouldShowToolTypeSet(rowTypes, activeTool) ? '' : 'none';
  });

  root.querySelectorAll('.call-item').forEach(item => {
    const rowBadge = item.querySelector('.tool-badge');
    const rowType = item.dataset.callType
      || (rowBadge ? [...rowBadge.classList].find(c => ['bash', 'read', 'write', 'mcp', 'agent', 'other'].includes(c)) || '' : '');
    item.style.display = shouldShowToolType(rowType, activeTool) ? '' : 'none';
  });

  root.querySelectorAll('.call-row').forEach(row => {
    if (row.closest('.call-item')) return;
    const rowBadge = row.querySelector('.tool-badge');
    const rowType = rowBadge ? [...rowBadge.classList].find(c => ['bash', 'read', 'write', 'mcp', 'agent', 'other'].includes(c)) || '' : '';
    row.style.display = shouldShowToolType(rowType, activeTool) ? '' : 'none';
  });
}

window.applyToolFilters = applyFilters;

function updateFilterSummary() {
  const el = document.getElementById('filterSummary');
  if (!el) return;
  const activeFilter = document.querySelector('.filter-chip-sm.active')?.dataset.filter || 'all';
  const parts = [];
  if (currentTool !== 'all') parts.push(`来源: ${currentTool}`);
  if (activeFilter !== 'all') parts.push(`类型: ${activeFilter}`);
  el.textContent = parts.length ? parts.join(' · ') : '';
}

// ─── 状态更新 ───────────────────────────────────────
async function checkStatus() {
  const ok = await checkHookStatus();
  const dot = document.getElementById('hookStatusDot');
  const text = document.getElementById('hookStatusText');
  if (dot) {
    dot.className = `w-2 h-2 rounded-full ${ok ? 'bg-success-500' : 'bg-danger-500'}`;
  }
  if (text) {
    text.textContent = ok ? 'Hook 在线' : 'Hook 离线';
  }
}

// ─── 来源采集状态（Claude/Codex 历史可导入 / Hook 是否安装） ───
async function updateSourceStatus() {
  const status = await fetchSourceStatus();
  const spans = document.querySelectorAll('[data-status-source]');
  spans.forEach(span => {
    const source = span.dataset.statusSource;
    const info = status[source];
    if (!info) return;
    const { historyAvailable, hookInstalled, sessionFiles, hookCoverage } = info;
    let label;
    let tone = 'neutral';
    if (source === 'codex' && hookInstalled && hookCoverage && !hookCoverage.complete) {
      label = `生命周期 ${hookCoverage.configured}/${hookCoverage.expected}`;
      tone = 'warn';
    } else if (hookInstalled && historyAvailable) {
      label = '实时采集中';
      tone = 'ok';
    } else if (hookInstalled) {
      label = '实时采集中';
      tone = 'ok';
    } else if (historyAvailable) {
      label = `历史可导入 · Hook 未安装`;
      tone = 'warn';
    } else {
      label = 'Hook 未安装';
      tone = 'muted';
    }
    span.textContent = label;
    span.dataset.tone = tone;
    const details = [];
    if (historyAvailable) details.push(`已有 ${sessionFiles} 个历史会话文件可导入`, `数据目录: ${info.dataDir || ''}`);
    else details.push('未发现历史数据，安装 Hook 后实时采集');
    if (hookCoverage) {
      details.push(`AgentLens Codex Hook：${hookCoverage.configured}/${hookCoverage.expected}`);
      if (hookCoverage.missingEvents?.length) details.push(`缺少：${hookCoverage.missingEvents.join('、')}`);
    }
    span.title = details.join('\n');
  });
}

async function updateCapabilityMatrix() {
  const root = document.getElementById('capabilityMatrix');
  if (!root) return;
  const result = await fetchCapabilities();
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  if (!sources.length) {
    root.innerHTML = '<div class="capability-empty">暂时无法读取数据完整度说明</div>';
    return;
  }
  const statusLabel = { supported: '已捕获', partial: '部分可见', unavailable: '不可观察' };
  const policy = result?.capture_policy || {};
  const modeLabel = { off: '关闭', redacted: '脱敏采集', full: '完整采集' };
  root.innerHTML = `
    <div class="capture-policy-summary">
      <strong>当前采集策略</strong>
      <span>提示词：${modeLabel[policy.prompt] || '未知'}</span>
      <span>工具数据：${modeLabel[policy.tool] || '未知'}</span>
      <span>配置：${modeLabel[policy.config] || '未知'}</span>
      <span>环境：${modeLabel[policy.environment] || '未知'}</span>
    </div>
  ` + sources.map(source => `
    <section class="capability-source" data-source="${escapeHtml(source.source)}">
      <div class="capability-source-head">
        <strong>${escapeHtml(source.label)}</strong>
        <span class="capability-level ${escapeHtml(source.completeness)}">${source.completeness === 'unavailable' ? '不可用' : source.completeness === 'limited' ? '有限' : '部分完整'}</span>
      </div>
      <p>${escapeHtml(source.summary || '')}</p>
      <div class="capability-items">
        ${(source.capabilities || []).map(item => `
          <span class="capability-item ${escapeHtml(item.status)}" title="${escapeHtml(item.reason || '')}">
            ${escapeHtml(item.label)} · ${statusLabel[item.status] || escapeHtml(item.status)}
          </span>
        `).join('')}
      </div>
    </section>
  `).join('');
}

function updateStatusFromSessions(sessions) {
  let errorCount = 0;
  let slowCount = 0;
  for (const s of sessions) {
    errorCount += s.error_count || 0;
    if ((s.total_duration_ms || 0) > 5000) slowCount++;
  }

  const errCount = document.getElementById('lastErrorCount');
  if (errCount) errCount.textContent = `${errorCount} 个错误`;

  const slowEl = document.getElementById('slowCount');
  if (slowEl) slowEl.textContent = `${slowCount} 个慢调用`;
}

function updateStatusFromLogs(logs) {
  const errors = logs.filter(l => l.error || l.exit_code !== 0);
  const slow = logs.filter(l => l.duration_ms > CONFIG.SLOW_THRESHOLD);

  // 错误计数 badge
  const errCount = document.getElementById('lastErrorCount');
  const errTooltip = document.getElementById('lastErrorTooltip');
  if (errCount) errCount.textContent = `${errors.length} 个错误`;
  if (errTooltip && errors.length > 0) {
    const latest = errors[errors.length - 1];
    const msg = latest.error || latest.tool_name || '未知错误';
    errTooltip.title = `最近: ${msg}`;
    errTooltip.classList.remove('hidden');
  }

  const slowCount = document.getElementById('slowCount');
  if (slowCount) slowCount.textContent = `${slow.length} 个慢调用`;
}

// ─── 全局函数（HTML onclick 用）─────────────────────
window.setTimeRange = function (range) {
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.range === range);
  });
  loadDashboardData(currentProject, range, currentTool === 'all' ? '' : currentTool);
};

// ─── 会话展开/折叠 ─────────────────────────────────
window.toggleSession = function (el) {
  // 兼容：传入 header 或 card
  const card = el.classList.contains('session-card') ? el : el.closest('.session-card');
  if (!card) return;
  const body = card.querySelector('.session-body');
  const arrow = card.querySelector('.session-arrow');
  if (body) {
    body.classList.toggle('hidden');
    if (arrow) {
      arrow.style.transform = body.classList.contains('hidden') ? '' : 'rotate(90deg)';
    }
    // 选中态高亮
    if (!body.classList.contains('hidden')) {
      document.querySelectorAll('.session-card.selected').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
    // 首次展开时加载调用详情
    if (!body.classList.contains('hidden') && !body.dataset.loaded) {
      loadSessionCalls(card);
    }
  }
};

async function loadSessionCalls(card) {
  const sessionId = card.dataset.sessionId;
  const source = card.dataset.source;
  if (!sessionId) return;

  const body = card.querySelector('.session-body');
  if (!body) return;

  try {
    const params = new URLSearchParams();
    params.set('session', sessionId);
    if (source) params.set('source', source);
    params.set('limit', '5000');

    const res = await fetch(`${CONFIG.API_BASE}/api/timeline?${params}`);
    if (!res.ok) {
      body.innerHTML = '<div class="text-center py-4 text-neutral-400 text-sm">加载失败</div>';
      return;
    }

    const data = await res.json();
    const calls = (data.items || []).map(item => ({
      ...item,
      input_summary: typeof item.input_summary === 'string' ? JSON.parse(item.input_summary) : (item.input_summary || {}),
    }));

    if (calls.length === 0) {
      body.innerHTML = '<div class="text-center py-4 text-neutral-400 text-sm">暂无调用记录</div>';
    } else {
      // 会话头调用统计以 timeline 的工具结果事件为统一口径。
      const toolRecords = calls.filter(c => c.role === 'tool_result' || c.role === 'tool_error');
      const errRecords = toolRecords.filter(c => c.role === 'tool_error' || c.error === true || c.success === false || c.success === 0 || c.error_message || (c.exit_code != null && c.exit_code !== 0));
      card.querySelectorAll('.session-metric').forEach(metric => {
        const label = metric.querySelector('.session-metric-label')?.textContent;
        const value = metric.querySelector('.session-metric-value');
        if (!label || !value) return;
        if (label === '调用') value.textContent = String(toolRecords.length);
        if (label === '成功') value.textContent = String(Math.max(toolRecords.length - errRecords.length, 0));
        if (label === '错误') value.textContent = String(errRecords.length);
      });
      // 动态导入 renderCallChain 中的 renderCall 函数
      const { renderCallChainCalls } = await import('./callchain/index.js');
      body.innerHTML = renderCallChainCalls(calls);
      applyFilters(body);
    }
    body.dataset.loaded = '1';
  } catch {
    body.innerHTML = '<div class="text-center py-4 text-neutral-400 text-sm">加载失败</div>';
  }
}

window.toggleAllSessions = function () {
  const cards = document.querySelectorAll('.session-card');
  const action = getExpandAllAction(Array.from(cards).map(card => {
    const body = card.querySelector('.session-body');
    return !!body && !body.classList.contains('hidden');
  }));
  const shouldExpand = action === 'expand';
  const toLoad = [];
  cards.forEach(card => {
    const body = card.querySelector('.session-body');
    const arrow = card.querySelector('.session-arrow');
    if (body) {
      if (shouldExpand) {
        body.classList.remove('hidden');
        if (!body.dataset.loaded) toLoad.push(card);
      } else {
        body.classList.add('hidden');
        card.classList.remove('selected');
      }
    }
    if (arrow) {
      arrow.style.transform = shouldExpand ? 'rotate(90deg)' : '';
    }
  });
  // ponytail: batch load, 5 per batch, 300ms delay. 原来是 100 个并发
  for (let i = 0; i < toLoad.length; i += 5) {
    const batch = toLoad.slice(i, i + 5);
    if (i > 0) {
      setTimeout(() => batch.forEach(c => loadSessionCalls(c)), (i / 5) * 300);
    } else {
      batch.forEach(c => loadSessionCalls(c));
    }
  }
  // 更新按钮文字
  const btn = document.getElementById('expandAllBtn');
  if (btn) btn.textContent = shouldExpand ? '折叠全部' : '展开全部';
};

// 暴露 loadSessionCalls 到全局作用域，供 callchain 模块使用
window.loadSessionCalls = loadSessionCalls;

// ─── 错误定位：一键展开第一个报错调用并开启“只显示报错” ──
window.setSessionErrorFilter = function (card, on) {
  const container = card.querySelector('.rounds-container');
  if (container) container.dataset.nav = on ? 'error' : 'all';
  card.querySelectorAll('.round-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.roundnav === (on ? 'error' : 'all'));
  });
  card.querySelectorAll('.round-tools').forEach(panel => {
    const inErrorRound = panel.closest('.round-block')?.dataset.hasError === 'true';
    if (on && inErrorRound && panel.classList.contains('collapsed')) window.toggleRoundTools(panel.id);
    panel.dataset.errorsOnly = on ? 'true' : 'false';
    // 确保渲染过的调用行也能立即过滤（直接依据 data-call-error）
    panel.querySelectorAll('.call-item').forEach(item => {
      item.style.display = (on && item.dataset.callError !== 'true') ? 'none' : '';
    });
  });
};

window.jumpToErrors = async function () {
  const card = document.querySelector('.session-card[data-has-error="true"]');
  if (!card) return;
  const body = card.querySelector('.session-body');
  const arrow = card.querySelector('.session-arrow');
  if (body) {
    body.classList.remove('hidden');
    if (arrow) arrow.style.transform = 'rotate(90deg)';
    document.querySelectorAll('.session-card.selected').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    if (!body.dataset.loaded && window.loadSessionCalls) {
      await window.loadSessionCalls(card);
    }
    window.setSessionErrorFilter(card, true);
    // 滚动到第一个报错调用并闪烁高亮
    const firstErr = card.querySelector('.rounds-container .call-item[data-call-error="true"]');
    if (firstErr) {
      firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstErr.classList.add('flash-error');
      setTimeout(() => firstErr.classList.remove('flash-error'), 2500);
    } else {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
};
