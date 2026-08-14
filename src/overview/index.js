import { escapeHtml } from '../config.js';
import { fetchOverview } from '../utils.js';
import { filterOverviewTools, moveToolInOrder, orderOverviewTools } from '../ui-state.mjs';

let overviewLoaded = false;
let overviewData = null;
let currentOverviewSource = '';
let currentOverviewView = 'assets';
const OVERVIEW_CACHE_KEY = 'agent-lens-overview-cache-v1';
const TOOL_ORDER_KEY = 'agent-lens-tool-order-v2';
const OVERVIEW_REFRESH_MS = 60000;
const STABLE_TOOLS = [
  { tool: 'pi', display_name: 'Pi', description: 'Pi 编码智能体历史数据源。', order: 10, links: { homepage: 'https://pi.dev', docs: 'https://pi.dev/docs/latest', github: 'https://github.com/earendil-works/pi' }, theme: { accent: '#eab308', surface: '#fefce8' } },
  { tool: 'codex', display_name: 'Codex', description: 'OpenAI Codex 命令行编码智能体与本地桌面环境。', order: 20, links: { homepage: 'https://openai.com/codex', docs: 'https://developers.openai.com/codex', github: 'https://github.com/openai/codex' }, theme: { accent: '#10b981', surface: '#ecfdf5' } },
  { tool: 'claude-code', display_name: 'Claude Code CLI', description: 'Anthropic Claude Code 命令行编码助手。', order: 30, links: { homepage: 'https://www.anthropic.com/claude-code', docs: 'https://docs.anthropic.com/en/docs/claude-code', github: 'https://github.com/anthropics/claude-code' }, theme: { accent: '#f97316', surface: '#fff7ed' } },
  { tool: 'opencode', display_name: 'OpenCode', description: 'OpenCode 终端编码智能体。', order: 40, links: { homepage: 'https://opencode.ai', docs: 'https://opencode.ai/docs', github: 'https://github.com/sst/opencode' }, theme: { accent: '#06b6d4', surface: '#ecfeff' } },
  { tool: 'hermes', display_name: 'Hermes', description: 'Hermes 编码智能体历史数据源。', order: 50, links: {}, theme: { accent: '#8b5cf6', surface: '#f5f3ff' } },
  { tool: 'openclaw', display_name: 'OpenClaw', description: 'OpenClaw 编码智能体历史数据源。', order: 60, links: {}, theme: { accent: '#64748b', surface: '#f8fafc' } },
  { tool: 'cursor', display_name: 'Cursor', description: '基于 VS Code 的 AI 代码编辑器。', order: 70, links: { homepage: 'https://cursor.com', docs: 'https://docs.cursor.com', github: 'https://github.com/getcursor/cursor' }, theme: { accent: '#6366f1', surface: '#eef2ff' } },
];

const typeLabels = {
  skill: 'Skills',
  mcp: 'MCP',
  plugin: 'Plugins',
  extension: 'Extensions',
  hook: 'Hooks',
  adapter: 'Adapters',
  builtin: '内置能力',
};

const typeClasses = {
  skill: 'type-skill',
  mcp: 'type-mcp',
  plugin: 'type-plugin',
  extension: 'type-extension',
  hook: 'type-hook',
  adapter: 'type-adapter',
  builtin: 'type-builtin',
};

const statusLabels = {
  detected: '已检测',
  not_found: '未检测到',
  enabled: '已启用',
  installed: '已安装',
  configured: '已配置',
  available: '可用',
  unknown: '未知',
  complete: '完整',
  partial: '部分',
};

const evidenceTypeLabels = {
  runtime_hook: '运行时确认',
  native_log: '原生日志',
  local_database: '原生数据库',
  cli_diagnostic: 'CLI 诊断',
  static_scan: '静态发现',
  inference: '行为推断',
  unobservable: '不可观察',
};

const evidenceStatusLabels = {
  disk_discovered: '磁盘发现',
  agent_declared: 'Agent 声明',
  invoked: '本次调用',
  inferred_used: '推断使用',
  unavailable: '不可用',
  misconfigured: '配置异常',
};

const scopeLabels = {
  user: '用户级',
  project: '项目级',
  session: '会话级',
  command: '命令行',
  runtime: '运行时',
  unknown: '未知',
};

const reconciliationLabels = {
  runtime_and_history: '运行时 + 历史',
  runtime_only: '仅运行时',
  history_only: '历史模式',
  no_events: '暂无事件',
};

export function initOverview() {
  window.reloadOverview = () => loadOverview({ force: true });
  window.switchOverviewView = switchOverviewView;
  initToolTabOrdering();
  initOverviewActions();
  setInterval(() => {
    if (document.getElementById('tab-overview')?.classList.contains('active')) {
      loadOverview({ force: true, silent: true });
    }
  }, OVERVIEW_REFRESH_MS);
}

export async function loadOverview(options = {}) {
  const nextSource = options.source !== undefined ? options.source : currentOverviewSource;
  const sourceChanged = nextSource !== currentOverviewSource;
  currentOverviewSource = nextSource;
  if (overviewLoaded && !options.force && !sourceChanged) return;
  if (overviewLoaded && !options.force && sourceChanged && overviewData) {
    renderOverview(overviewData);
    return;
  }
  const loading = document.getElementById('overviewLoading');
  const empty = document.getElementById('overviewEmpty');
  const content = document.getElementById('overviewContent');
  const refresh = document.querySelector('.overview-refresh');
  const cached = readCachedOverview();
  const initial = cached || stableOverviewShell();
  if (!options.silent) {
    if (loading) loading.innerHTML = renderOverviewLoading('正在扫描本地能力资产...');
    setOverviewRefreshLoading(refresh, true);
    renderOverview(initial);
    content?.classList.remove('hidden');
    loading?.classList.add('hidden');
    empty?.classList.add('hidden');
  }

  const data = await fetchOverview();
  loading?.classList.add('hidden');
  setOverviewRefreshLoading(refresh, false);

  if (!data || !Array.isArray(data.tools)) {
    if (!initial && !options.silent) empty?.classList.remove('hidden');
    return;
  }

  renderOverview(data);
  overviewData = data;
  writeCachedOverview(data);
  content?.classList.remove('hidden');
  empty?.classList.add('hidden');
  overviewLoaded = true;
}

function renderOverviewLoading(label) {
  return `
    <div class="inline-loading compact">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function setOverviewRefreshLoading(button, loading) {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent || '';
    button.disabled = true;
    button.classList.add('loading-button');
    button.innerHTML = '<span class="loading-spinner" aria-hidden="true"></span><span>刷新中</span>';
  } else {
    button.disabled = false;
    button.classList.remove('loading-button');
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function renderOverview(data) {
  const tools = orderOverviewTools(data.tools || [], readToolOrder());
  const focusedTools = filterOverviewTools(tools, currentOverviewSource);
  const cards = document.getElementById('overviewToolCards');
  const matrix = document.getElementById('overviewMatrix');
  const assembly = document.getElementById('overviewAssembly');
  const configLens = document.getElementById('overviewConfigLens');
  if (cards) cards.innerHTML = focusedTools.map(renderToolCard).join('');
  if (matrix) matrix.innerHTML = renderMatrix(data.capability_matrix || [], tools);
  if (assembly) assembly.innerHTML = renderAssemblyView(focusedTools);
  if (configLens) configLens.innerHTML = renderConfigLensView(focusedTools);
  applyOverviewView();
}

function renderToolCard(tool) {
  const assets = tool.assets || [];
  const priorityAssets = assets.filter(asset => asset.is_priority);
  const accent = tool.theme?.accent || '#64748b';
  const surface = tool.theme?.surface || '#f8fafc';
  return `
    <article class="overview-card" style="--tool-accent:${escapeHtml(accent)}; --tool-surface:${escapeHtml(surface)}">
      <header class="overview-card-head">
        <div>
          <h3 class="overview-tool-name"><span></span>${escapeHtml(tool.display_name || tool.tool || '未知工具')}</h3>
          <p class="overview-tool-desc">${escapeHtml(tool.description || '暂无介绍')}</p>
          ${renderToolLinks(tool.links || {})}
        </div>
        <span class="overview-status ${tool.status === 'detected' ? 'ok' : 'muted'}">${escapeHtml(statusLabels[tool.status] || tool.status || '未知')}</span>
      </header>

      <div class="overview-meta-grid">
        <div><span>版本</span><b>${escapeHtml(tool.version || '未检测')}</b></div>
        <div><span>配置目录</span><b title="${escapeHtml(tool.config_dir || '')}">${escapeHtml(shortPath(tool.config_dir || '未检测'))}</b></div>
      </div>

      <div class="overview-asset-summary">
        ${Object.entries(tool.asset_groups || {}).filter(([, group]) => group.count > 0).map(([type, group]) => `
          <span class="${escapeHtml(typeClasses[type] || 'type-builtin')}">${escapeHtml(typeLabels[type] || type)} <b>${group.count}</b></span>
        `).join('') || '<span>暂无可识别资产</span>'}
      </div>

      <section class="overview-priority">
        <div class="overview-section-title">高频资产</div>
        ${priorityAssets.length ? `<div class="overview-asset-card-grid priority">${priorityAssets.slice(0, 6).map(renderAssetCard).join('')}</div>` : '<div class="overview-empty-line">暂无达到高频阈值的资产</div>'}
      </section>

      <section class="overview-groups">
        ${Object.entries(tool.asset_groups || {}).filter(([, group]) => group.count > 0).map(([type, group]) => renderAssetGroup(type, group.items || [])).join('')}
      </section>
    </article>
  `;
}

function renderAssetGroup(type, assets) {
  return `
    <details class="overview-group">
      <summary>${escapeHtml(typeLabels[type] || type)} <span>${assets.length}</span></summary>
      <div class="overview-asset-list">
        ${assets.slice(0, 24).map(renderAssetCard).join('')}
      </div>
    </details>
  `;
}

function renderAssetCard(asset) {
  const pathText = asset.path || '';
  return `
    <div class="overview-asset-card ${escapeHtml(typeClasses[asset.type] || 'type-builtin')} ${asset.is_priority ? 'is-priority' : ''}" title="${escapeHtml(asset.path || asset.description || '')}">
      <div class="overview-asset-card-top">
        <span>${escapeHtml(typeLabels[asset.type] || asset.type || '能力')}</span>
        ${asset.is_priority ? '<em>高频</em>' : ''}
      </div>
      <b>${escapeHtml(asset.name || 'unknown')}</b>
      ${pathText ? `
        <div class="overview-asset-path">
          <span title="${escapeHtml(pathText)}">${escapeHtml(shortPath(pathText, 54))}</span>
          <button type="button" data-overview-copy-path data-path="${escapeHtml(pathText)}" title="复制安装路径">复制</button>
        </div>
      ` : ''}
      <div class="overview-asset-card-meta">
        <small>${escapeHtml(statusLabels[asset.status] || asset.status || '未知')}</small>
        <small>${asset.call_count || 0} 次</small>
      </div>
    </div>
  `;
}

function renderToolLinks(links) {
  const items = [
    ['homepage', '官网'],
    ['github', 'GitHub'],
    ['docs', '文档'],
  ].filter(([key]) => isSafeHttpUrl(links[key]));
  if (!items.length) return '';
  return `
    <div class="overview-tool-links">
      ${items.map(([key, label]) => `<a href="${escapeHtml(links[key])}" target="_blank" rel="noopener noreferrer">${label}</a>`).join('')}
    </div>
  `;
}

function renderMatrix(rows, tools) {
  if (!rows.length) {
    return '<div class="overview-empty-line">暂无高频资产对照数据。产生更多调用后，这里会显示优质资产在其他工具中的覆盖情况。</div>';
  }

  return `
    <div class="overview-matrix-table" style="--tool-count:${tools.length}">
      <div class="overview-matrix-header">
        <span>高频资产</span>
        ${tools.map(tool => `<span>${escapeHtml(tool.display_name || tool.tool)}</span>`).join('')}
      </div>
      ${rows.slice(0, 12).map(row => `
        <div class="overview-matrix-row" style="--source-accent:${escapeHtml(sourceAccent(row.source_tool, tools))}">
          <span>
            <b>${escapeHtml(row.name || row.capability)}</b>
            <small>${row.call_count || 0} 次</small>
          </span>
          ${tools.map(tool => renderCoverage(row.coverage?.[tool.tool], tool.tool === row.source_tool)).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderCoverage(cell = {}, source = false) {
  const status = cell.status || '未知';
  const cls = status === '已有' ? 'ok' : status === '缺失' ? 'missing' : 'muted';
  return `<span class="overview-coverage ${cls} ${source ? 'source' : ''}" title="${escapeHtml(cell.asset_name || '')}">${escapeHtml(status)}</span>`;
}

function renderAssemblyView(tools) {
  if (!tools.length) {
    return '<div class="list-card overview-loading">当前来源暂无装配路径数据</div>';
  }
  return `
    <div class="overview-assembly-grid">
      ${tools.map(renderAssemblyCard).join('')}
    </div>
  `;
}

function renderAssemblyCard(tool) {
  const paths = Array.isArray(tool.paths) ? tool.paths : [];
  const skillFlow = Array.isArray(tool.load_flow) ? tool.load_flow.find(flow => flow.type === 'skill') : null;
  const accent = tool.theme?.accent || '#64748b';
  const surface = tool.theme?.surface || '#f8fafc';
  return `
    <article class="overview-assembly-card" style="--tool-accent:${escapeHtml(accent)}; --tool-surface:${escapeHtml(surface)}">
      <header class="overview-assembly-head">
        <div>
          <h3 class="overview-tool-name"><span></span>${escapeHtml(tool.display_name || tool.tool || '未知工具')}</h3>
          <p class="overview-tool-desc">${escapeHtml(tool.config_dir || '未检测到配置目录')}</p>
        </div>
        <span class="overview-status ${tool.status === 'detected' ? 'ok' : 'muted'}">${escapeHtml(statusLabels[tool.status] || tool.status || '未知')}</span>
      </header>
      <div class="overview-path-list">
        ${paths.length ? paths.map(renderAssemblyPath).join('') : '<div class="overview-empty-line">暂无路径诊断数据</div>'}
      </div>
      ${renderSkillFlow(skillFlow)}
    </article>
  `;
}

function renderAssemblyPath(item) {
  const cls = statusClass(item.status);
  const pathText = item.path || '';
  return `
    <div class="overview-path-row ${cls}" title="${escapeHtml(item.description || '')}">
      <span class="overview-path-dot"></span>
      <div>
        <b>${escapeHtml(item.role || '路径')}</b>
        <small title="${escapeHtml(pathText)}">${escapeHtml(shortPath(pathText, 72) || '未配置')}</small>
      </div>
      <em>${escapeHtml(statusLabels[item.status] || pathStatusLabel(item.status))}</em>
    </div>
  `;
}

function renderSkillFlow(flow) {
  if (!flow) {
    return `
      <section class="overview-skill-flow">
        <div class="overview-section-title">SKILL 加载</div>
        <div class="overview-empty-line">暂无可识别的 SKILL 来源</div>
      </section>
    `;
  }
  const sources = Object.values(flow.sources || {}).filter(item => item.count > 0);
  return `
    <section class="overview-skill-flow">
      <div class="overview-section-title">SKILL 加载</div>
      <div class="overview-flow-strip">
        <span><b>${flow.installed_count || 0}</b><small>已安装</small></span>
        <i></i>
        <span><b>${flow.discoverable_count || 0}</b><small>可发现</small></span>
        <i></i>
        <span><b>${flow.used_count || 0}</b><small>已使用</small></span>
      </div>
      <div class="overview-source-list">
        ${sources.length ? sources.map(source => `
          <div>
            <span>${escapeHtml(source.label || '来源')}</span>
            <b>${source.count || 0}</b>
            <small>${source.used_count || 0} 个已使用</small>
          </div>
        `).join('') : '<div><span>暂无来源</span><b>0</b><small>0 个已使用</small></div>'}
      </div>
    </section>
  `;
}

export function renderConfigLensView(tools) {
  if (!tools.length) {
    return '<div class="list-card overview-loading">当前来源暂无配置证据数据</div>';
  }
  return `
    <div class="overview-config-grid">
      ${tools.map(renderConfigLensCard).join('')}
    </div>
  `;
}

function renderConfigLensCard(tool) {
  const runtime = tool.runtime_status || {};
  const reconciliation = tool.reconciliation || {};
  const configChain = Array.isArray(tool.config_chain) ? tool.config_chain : [];
  const evidence = Array.isArray(tool.evidence) ? tool.evidence : [];
  const assetEvidence = evidence.filter(item => item.subject_type !== 'config' && item.subject_type !== 'runtime');
  const invoked = assetEvidence.filter(item => item.status === 'invoked');
  const staticOnly = assetEvidence.filter(item => item.status === 'disk_discovered');
  const gaps = evidence.filter(item => item.visibility === 'unobservable' || item.status === 'misconfigured' || item.status === 'unavailable');
  const accent = tool.theme?.accent || '#64748b';
  const surface = tool.theme?.surface || '#f8fafc';
  return `
    <article class="overview-config-card" style="--tool-accent:${escapeHtml(accent)}; --tool-surface:${escapeHtml(surface)}">
      <header class="overview-config-head">
        <div>
          <h3 class="overview-tool-name"><span></span>${escapeHtml(tool.display_name || tool.tool || '未知工具')}</h3>
          <p class="overview-tool-desc">${escapeHtml(configLensSummary(tool, runtime))}</p>
        </div>
        <span class="overview-status ${runtime.status === 'available' ? 'ok' : 'muted'}">${escapeHtml(runtimeStatusLabel(runtime.status))}</span>
      </header>

      <div class="overview-config-metrics">
        <div><span>静态发现</span><b>${staticOnly.length}</b></div>
        <div><span>调用确认</span><b>${invoked.length}</b></div>
        <div><span>缺口</span><b>${gaps.length}</b></div>
      </div>

      ${renderReconciliation(reconciliation)}

      <section class="overview-config-section">
        <div class="overview-section-title">配置覆盖链</div>
        <div class="overview-config-chain">
          ${configChain.length ? configChain.slice(0, 8).map(renderConfigChainItem).join('') : '<div class="overview-empty-line">暂无配置路径证据</div>'}
        </div>
      </section>

      <section class="overview-config-section">
        <div class="overview-section-title">能力证据</div>
        <div class="overview-evidence-list">
          ${assetEvidence.length ? assetEvidence.slice(0, 12).map(renderEvidenceItem).join('') : '<div class="overview-empty-line">暂无能力证据</div>'}
        </div>
      </section>
    </article>
  `;
}

function renderReconciliation(reconciliation = {}) {
  const mode = reconciliation.mode || 'no_events';
  const cls = reconciliation.status === 'matched'
    ? 'ok'
    : reconciliation.status === 'degraded' || reconciliation.status === 'conflict'
      ? 'missing'
      : 'muted';
  return `
    <section class="overview-config-section">
      <div class="overview-section-title">运行时/历史对账</div>
      <div class="overview-reconcile ${cls}" title="${escapeHtml(reconciliation.gap_reason || '')}">
        <span><b>${escapeHtml(reconciliationLabels[mode] || mode)}</b><small>对账模式</small></span>
        <span><b>${Number(reconciliation.runtime_events || 0)}</b><small>运行时事件</small></span>
        <span><b>${Number(reconciliation.history_events || 0)}</b><small>历史/本地事件</small></span>
        <span><b>${escapeHtml(reconciliation.last_observed_at ? formatDateTime(reconciliation.last_observed_at) : '暂无')}</b><small>最后证据</small></span>
      </div>
      ${renderToolReconciliation(reconciliation.details?.tool_calls)}
      ${reconciliation.gap_reason ? `<div class="overview-reconcile-gap">${escapeHtml(reconciliation.gap_reason)}</div>` : ''}
    </section>
  `;
}

function renderToolReconciliation(details = null) {
  if (!details || !Number(details.tool_call_count || 0)) return '';
  return `
    <div class="overview-tool-reconcile">
      <span><b>${Number(details.matched_calls || 0)}</b><small>工具已对账</small></span>
      <span><b>${Number(details.runtime_only_calls || 0)}</b><small>仅运行时</small></span>
      <span><b>${Number(details.history_only_calls || 0)}</b><small>仅历史</small></span>
      <span class="${Number(details.conflict_calls || 0) ? 'danger' : ''}"><b>${Number(details.conflict_calls || 0)}</b><small>冲突</small></span>
    </div>
  `;
}

function configLensSummary(tool, runtime) {
  if (runtime.degradation_reason) return runtime.degradation_reason;
  if (runtime.last_event_at) return `最后确认事件：${formatDateTime(runtime.last_event_at)}`;
  return tool.config_dir ? `配置目录：${shortPath(tool.config_dir, 80)}` : '尚未检测到配置目录';
}

function runtimeStatusLabel(status) {
  const labels = {
    available: '运行可用',
    observed_history: '历史确认',
    unknown: '待确认',
  };
  return labels[status] || status || '待确认';
}

function renderConfigChainItem(item) {
  return `
    <div class="overview-config-chain-row ${evidenceClass(item)}">
      <span>${escapeHtml(scopeLabels[item.scope] || item.scope || '未知')}</span>
      <b>${escapeHtml(item.label || '配置项')}</b>
      <small title="${escapeHtml(item.path || item.missing_reason || '')}">${escapeHtml(shortPath(item.path || item.missing_reason || '无路径', 72))}</small>
      <em>${escapeHtml(evidenceTypeLabels[item.evidence_type] || item.evidence_type || '证据')}</em>
    </div>
  `;
}

function renderEvidenceItem(item) {
  return `
    <div class="overview-evidence-row ${evidenceClass(item)}" title="${escapeHtml(item.missing_reason || '')}">
      <span>${escapeHtml(typeLabels[item.subject_type] || item.subject_type || '能力')}</span>
      <b>${escapeHtml(item.label || item.subject_id || 'unknown')}</b>
      <small>${escapeHtml(evidenceStatusLabels[item.status] || item.status || '未知')} · ${escapeHtml(evidenceTypeLabels[item.evidence_type] || item.evidence_type || '证据')}</small>
      <em>${escapeHtml(item.observed_at ? formatDateTime(item.observed_at) : (scopeLabels[item.scope] || item.scope || ''))}</em>
    </div>
  `;
}

function evidenceClass(item = {}) {
  if (item.visibility === 'unobservable' || item.status === 'misconfigured' || item.status === 'unavailable') return 'missing';
  if (item.status === 'invoked' || item.evidence_type === 'runtime_hook') return 'ok';
  return 'muted';
}

function statusClass(status) {
  if (status === 'exists' || status === 'configured' || status === 'enabled' || status === 'detected' || status === 'complete') return 'ok';
  if (status === 'missing' || status === 'not_found') return 'missing';
  return 'muted';
}

function pathStatusLabel(status) {
  const labels = {
    exists: '存在',
    missing: '缺失',
    observed: '已观察',
  };
  return labels[status] || status || '未知';
}

function switchOverviewView(view) {
  currentOverviewView = ['assets', 'assembly', 'config'].includes(view) ? view : 'assets';
  applyOverviewView();
}

function applyOverviewView() {
  document.querySelectorAll('.overview-view-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.overviewView === currentOverviewView);
  });
  document.getElementById('overviewAssetsView')?.classList.toggle('hidden', currentOverviewView !== 'assets');
  document.getElementById('overviewAssemblyView')?.classList.toggle('hidden', currentOverviewView !== 'assembly');
  document.getElementById('overviewConfigView')?.classList.toggle('hidden', currentOverviewView !== 'config');
}

function shortPath(value, maxLength = 42) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `...${text.slice(-(maxLength - 3))}`;
}

function sourceAccent(toolName, tools) {
  return tools.find(tool => tool.tool === toolName)?.theme?.accent || '#64748b';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function readCachedOverview() {
  try {
    const raw = localStorage.getItem(OVERVIEW_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return Array.isArray(cached?.tools) ? cached : null;
  } catch {
    return null;
  }
}

function writeCachedOverview(data) {
  try {
    localStorage.setItem(OVERVIEW_CACHE_KEY, JSON.stringify({
      ...data,
      cached_at: new Date().toISOString(),
    }));
  } catch {
    // localStorage may be unavailable in private or restricted contexts.
  }
}

function readToolOrder() {
  try {
    const raw = localStorage.getItem(TOOL_ORDER_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeToolOrder(order) {
  try {
    localStorage.setItem(TOOL_ORDER_KEY, JSON.stringify(order));
  } catch {
    // 本地排序只是偏好设置，无法写入时保持默认顺序。
  }
}

function currentTabToolOrder() {
  return Array.from(document.querySelectorAll('#toolTabs .tool-tab[data-tool]'))
    .map(tab => tab.dataset.tool)
    .filter(tool => tool && tool !== 'all');
}

function applyToolTabOrder(order = readToolOrder()) {
  const tabs = document.getElementById('toolTabs');
  if (!tabs) return;
  const allTab = tabs.querySelector('.tool-tab[data-tool="all"]');
  const toolTabs = Array.from(tabs.querySelectorAll('.tool-tab[data-tool]'))
    .filter(tab => tab.dataset.tool !== 'all')
    .map(tab => ({ tool: tab.dataset.tool, tab, order: STABLE_TOOLS.find(item => item.tool === tab.dataset.tool)?.order ?? 999 }));
  const ordered = orderOverviewTools(toolTabs, order);
  if (allTab) tabs.appendChild(allTab);
  for (const item of ordered) tabs.appendChild(item.tab);
}

function initToolTabOrdering() {
  const tabs = document.getElementById('toolTabs');
  if (!tabs) return;
  applyToolTabOrder();
  tabs.querySelectorAll('.tool-tab[data-tool]').forEach(tab => {
    if (tab.dataset.tool === 'all') return;
    tab.draggable = true;
    tab.title = [tab.title, '拖动可调整工具顺序'].filter(Boolean).join(' · ');
  });
  let draggedTool = '';
  tabs.addEventListener('dragstart', event => {
    const tab = event.target.closest?.('.tool-tab[data-tool]');
    if (!tab || tab.dataset.tool === 'all') return;
    draggedTool = tab.dataset.tool;
    event.dataTransfer?.setData('text/plain', draggedTool);
    event.dataTransfer.effectAllowed = 'move';
    tab.classList.add('is-dragging');
  });
  tabs.addEventListener('dragend', () => {
    tabs.querySelectorAll('.tool-tab.is-dragging').forEach(tab => tab.classList.remove('is-dragging'));
    draggedTool = '';
  });
  tabs.addEventListener('dragover', event => {
    const tab = event.target.closest?.('.tool-tab[data-tool]');
    if (!tab || tab.dataset.tool === 'all') return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  tabs.addEventListener('drop', event => {
    const tab = event.target.closest?.('.tool-tab[data-tool]');
    if (!tab || tab.dataset.tool === 'all') return;
    event.preventDefault();
    const source = draggedTool || event.dataTransfer?.getData('text/plain');
    const current = readToolOrder().length ? readToolOrder() : currentTabToolOrder();
    const next = moveToolInOrder(current, source, tab.dataset.tool);
    writeToolOrder(next);
    applyToolTabOrder(next);
    if (overviewData) renderOverview(overviewData);
  });
}

function initOverviewActions() {
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-overview-copy-path]');
    if (!button) return;
    const value = button.dataset.path || '';
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      const previous = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = previous; }, 1200);
    }).catch(() => {
      window.prompt('复制路径', value);
    });
  });
}

function isSafeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function stableOverviewShell() {
  return {
    tools: STABLE_TOOLS.map(tool => ({
      ...tool,
      version: '查询后更新',
      status: 'unknown',
      config_dir: '查询后更新',
      paths: [],
      evidence: [],
      config_chain: [],
      runtime_status: { status: 'unknown' },
      reconciliation: { status: 'unknown', mode: 'no_events' },
      capability_matrix: [],
      load_flow: [],
      assets: [],
      asset_groups: {},
    })),
    priority_assets: [],
    capability_matrix: [],
  };
}
