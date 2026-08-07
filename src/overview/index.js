import { escapeHtml } from '../config.js';
import { fetchOverview } from '../utils.js';

let overviewLoaded = false;

const typeLabels = {
  skill: 'Skills',
  mcp: 'MCP',
  plugin: 'Plugins',
  extension: 'Extensions',
  hook: 'Hooks',
  adapter: 'Adapters',
  builtin: '内置能力',
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
}

export async function loadOverview(options = {}) {
  if (overviewLoaded && !options.force) return;
  const loading = document.getElementById('overviewLoading');
  const empty = document.getElementById('overviewEmpty');
  const content = document.getElementById('overviewContent');
  loading?.classList.remove('hidden');
  empty?.classList.add('hidden');
  content?.classList.add('hidden');

  const data = await fetchOverview();
  loading?.classList.add('hidden');

  if (!data || !Array.isArray(data.tools)) {
    empty?.classList.remove('hidden');
    return;
  }

  renderOverview(data);
  content?.classList.remove('hidden');
  overviewLoaded = true;
}

function renderOverview(data) {
  const tools = data.tools || [];
  const cards = document.getElementById('overviewToolCards');
  const matrix = document.getElementById('overviewMatrix');
  if (cards) cards.innerHTML = tools.map(renderToolCard).join('');
  if (matrix) matrix.innerHTML = renderMatrix(data.capability_matrix || [], tools);
}

function renderToolCard(tool) {
  const assets = tool.assets || [];
  const priorityAssets = assets.filter(asset => asset.is_priority);
  return `
    <article class="overview-card">
      <header class="overview-card-head">
        <div>
          <h3 class="overview-tool-name">${escapeHtml(tool.display_name || tool.tool || '未知工具')}</h3>
          <p class="overview-tool-desc">${escapeHtml(tool.description || '暂无介绍')}</p>
        </div>
        <span class="overview-status ${tool.status === 'detected' ? 'ok' : 'muted'}">${escapeHtml(statusLabels[tool.status] || tool.status || '未知')}</span>
      </header>

      <div class="overview-meta-grid">
        <div><span>版本</span><b>${escapeHtml(tool.version || '未检测')}</b></div>
        <div><span>配置目录</span><b title="${escapeHtml(tool.config_dir || '')}">${escapeHtml(shortPath(tool.config_dir || '未检测'))}</b></div>
      </div>

      <div class="overview-asset-summary">
        ${Object.entries(tool.asset_groups || {}).filter(([, group]) => group.count > 0).map(([type, group]) => `
          <span>${escapeHtml(typeLabels[type] || type)} <b>${group.count}</b></span>
        `).join('') || '<span>暂无可识别资产</span>'}
      </div>

      <section class="overview-priority">
        <div class="overview-section-title">高频资产</div>
        ${priorityAssets.length ? priorityAssets.slice(0, 5).map(renderAssetLine).join('') : '<div class="overview-empty-line">暂无达到高频阈值的资产</div>'}
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
        ${assets.slice(0, 20).map(renderAssetLine).join('')}
      </div>
    </details>
  `;
}

function renderAssetLine(asset) {
  return `
    <div class="overview-asset-line">
      <span>
        <b>${escapeHtml(asset.name || 'unknown')}</b>
        <small>${escapeHtml(statusLabels[asset.status] || asset.status || '未知')}</small>
      </span>
      <span class="overview-asset-side">
        ${asset.is_priority ? '<em>高频</em>' : ''}
        <small>${asset.call_count || 0} 次</small>
      </span>
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
        <div class="overview-matrix-row">
          <span>
            <b>${escapeHtml(row.name || row.capability)}</b>
            <small>${row.call_count || 0} 次</small>
          </span>
          ${tools.map(tool => renderCoverage(row.coverage?.[tool.tool])).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderCoverage(cell = {}) {
  const status = cell.status || '未知';
  const cls = status === '已有' ? 'ok' : status === '缺失' ? 'missing' : 'muted';
  return `<span class="overview-coverage ${cls}" title="${escapeHtml(cell.asset_name || '')}">${escapeHtml(status)}</span>`;
}

function shortPath(value) {
  const text = String(value || '');
  if (text.length <= 42) return text;
  return `...${text.slice(-39)}`;
}
