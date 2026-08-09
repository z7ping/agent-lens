import { escapeHtml } from '../config.js';
import { fetchOverview } from '../utils.js';
import { filterOverviewTools, moveToolInOrder, orderOverviewTools } from '../ui-state.mjs';

let overviewLoaded = false;
let overviewData = null;
let currentOverviewSource = '';
const OVERVIEW_CACHE_KEY = 'agent-trace-overview-cache-v1';
const TOOL_ORDER_KEY = 'agent-trace-tool-order-v2';
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
};

export function initOverview() {
  window.reloadOverview = () => loadOverview({ force: true });
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
  const cached = readCachedOverview();
  const initial = cached || stableOverviewShell();
  if (!options.silent) {
    renderOverview(initial);
    content?.classList.remove('hidden');
    loading?.classList.add('hidden');
    empty?.classList.add('hidden');
  }

  const data = await fetchOverview();
  loading?.classList.add('hidden');

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

function renderOverview(data) {
  const tools = orderOverviewTools(data.tools || [], readToolOrder());
  const focusedTools = filterOverviewTools(tools, currentOverviewSource);
  const cards = document.getElementById('overviewToolCards');
  const matrix = document.getElementById('overviewMatrix');
  if (cards) cards.innerHTML = focusedTools.map(renderToolCard).join('');
  if (matrix) matrix.innerHTML = renderMatrix(data.capability_matrix || [], tools);
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

function shortPath(value, maxLength = 42) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `...${text.slice(-(maxLength - 3))}`;
}

function sourceAccent(toolName, tools) {
  return tools.find(tool => tool.tool === toolName)?.theme?.accent || '#64748b';
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
      assets: [],
      asset_groups: {},
    })),
    priority_assets: [],
    capability_matrix: [],
  };
}
