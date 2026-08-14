/**
 * dashboard/index.js - 工具栈地图模块
 */

import { escapeHtml, formatDuration } from '../config.js';
import { fetchToolMap } from '../utils.js';
import { isLatestRequest } from '../ui-state.mjs';

let currentTimeRange = 'week';
let currentProject = '';
let currentSource = '';
let currentToolMap = null;
let selectedToolKey = '';
let dashboardRequestId = 0;

const typeLabels = {
  cli: 'CLI',
  file: '文件',
  mcp: 'MCP',
  skill: 'Skill',
  agent: 'Agent',
  tool: 'Tool',
};

const recommendationClasses = {
  '保留': 'keep',
  '沉淀': 'keep',
  '观察': 'watch',
  '优化': 'risk',
  '待观察': 'muted',
};

export function initDashboard() {
  loadDashboardData().catch(e => console.error('[ToolMap] init error:', e));
}

export async function loadDashboardData(project, timeRange, source) {
  try {
    const requestId = ++dashboardRequestId;
    if (project !== undefined) currentProject = project;
    if (timeRange) currentTimeRange = timeRange;
    if (source !== undefined) currentSource = source;
    renderLoadingState();

    const data = await fetchToolMap(currentProject, currentSource, currentTimeRange);
    if (!isLatestRequest(requestId, dashboardRequestId)) return;
    currentToolMap = data;
    selectedToolKey = '';

    const hasData = !!data && Array.isArray(data.items) && data.items.length > 0;
    document.getElementById('dashboardEmpty')?.classList.toggle('hidden', hasData);
    document.getElementById('dashboardContent')?.classList.toggle('hidden', !hasData);
    if (!hasData) {
      renderSummary({ total_tools: 0, high_value_tools: 0, high_risk_tools: 0, workflow_candidates: 0 });
      renderToolTable([]);
      renderWorkflowPatterns([]);
      renderToolDetail(null);
      return;
    }

    renderSummary(data.summary || {});
    renderToolTable(data.items || []);
    renderWorkflowPatterns(data.workflow_patterns || []);
    selectFirstTool(data.items || []);
  } catch (e) {
    console.error('[ToolMap] loadDashboardData error:', e);
  }
}

function renderLoadingState() {
  const table = document.getElementById('toolMapTable');
  if (table) {
    table.innerHTML = `
      <div class="inline-loading compact">
        <span class="loading-spinner" aria-hidden="true"></span>
        <span>正在加载工具评分...</span>
      </div>
    `;
  }
  renderToolDetail(null);
}

function renderSummary(summary) {
  setText('totalTools', summary.total_tools || 0);
  setText('highValueTools', summary.high_value_tools || 0);
  setText('highRiskTools', summary.high_risk_tools || 0);
  setText('workflowCandidates', summary.workflow_candidates || 0);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function toolKey(tool) {
  return `${tool.source || ''}::${tool.tool_name || ''}`;
}

function renderToolTable(items) {
  const container = document.getElementById('toolMapTable');
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="text-sm text-neutral-400 py-6 text-center">暂无工具评分数据</div>';
    return;
  }

  container.innerHTML = `
    <div class="tool-table-header">
      <span>工具</span>
      <span>价值分</span>
      <span>调用</span>
      <span>会话</span>
      <span>成功率</span>
      <span>平均耗时</span>
      <span>建议</span>
    </div>
    ${items.map(renderToolRow).join('')}
  `;
}

function renderToolRow(tool) {
  const key = toolKey(tool);
  const successRate = `${((tool.success_rate || 0) * 100).toFixed(0)}%`;
  const recClass = recommendationClasses[tool.recommendation] || 'muted';
  return `
    <button class="tool-table-row" type="button" data-tool-key="${escapeHtml(key)}" onclick="selectToolMapItem('${escapeForJs(key)}')">
      <span class="tool-name-cell">
        <span class="tool-name">${escapeHtml(tool.tool_name || '未知')}</span>
        <span class="tool-type">${escapeHtml(typeLabels[tool.tool_type] || tool.tool_type || 'Tool')} · ${escapeHtml(tool.source || 'unknown')}</span>
      </span>
      <span><span class="score-pill ${scoreTone(tool.value_score)}">${tool.value_score || 0}</span></span>
      <span>${tool.call_count || 0}</span>
      <span>${tool.session_count || 0}</span>
      <span>${successRate}</span>
      <span>${formatDuration(tool.avg_duration_ms || 0)}</span>
      <span><span class="recommendation ${recClass}">${escapeHtml(tool.recommendation || '观察')}</span></span>
    </button>
  `;
}

function scoreTone(score = 0) {
  if (score >= 70) return 'good';
  if (score >= 45) return 'mid';
  return 'low';
}

function escapeForJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function selectFirstTool(items) {
  if (!items.length) {
    renderToolDetail(null);
    return;
  }
  window.selectToolMapItem(toolKey(items[0]));
}

window.selectToolMapItem = function (key) {
  selectedToolKey = key;
  document.querySelectorAll('.tool-table-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.toolKey === key);
  });
  const tool = (currentToolMap?.items || []).find(item => toolKey(item) === key);
  renderToolDetail(tool || null);
};

function renderToolDetail(tool) {
  const container = document.getElementById('toolDetailPanel');
  if (!container) return;
  if (!tool) {
    container.innerHTML = '<div class="text-sm text-neutral-400 py-6 text-center">选择一个工具查看评分解释</div>';
    return;
  }

  const riskLabels = (tool.risk_labels || []).length
    ? tool.risk_labels.map(label => `<span class="risk-tag">${escapeHtml(label)}</span>`).join('')
    : '<span class="risk-tag muted">暂无明显风险</span>';

  container.innerHTML = `
    <div class="tool-detail-head">
      <div>
        <div class="tool-detail-name">${escapeHtml(tool.tool_name || '未知')}</div>
        <div class="tool-detail-meta">${escapeHtml(typeLabels[tool.tool_type] || tool.tool_type || 'Tool')} · ${escapeHtml(tool.source || 'unknown')}</div>
      </div>
      <span class="score-pill ${scoreTone(tool.value_score)} large">${tool.value_score || 0}</span>
    </div>

    <div class="score-breakdown">
      ${renderScoreBar('频率', tool.frequency_score || 0, 40)}
      ${renderScoreBar('工作流', tool.workflow_score || 0, 35)}
      ${renderScoreBar('省时', tool.time_saving_score || 0, 25)}
      ${renderScoreBar('风险扣分', tool.risk_penalty || 0, 30, true)}
    </div>

    <div class="detail-section-lite">
      <div class="detail-section-title">解释</div>
      <ul class="explanation-list">
        ${(tool.explanations || []).map(text => `<li>${escapeHtml(text)}</li>`).join('')}
      </ul>
    </div>

    <div class="detail-section-lite">
      <div class="detail-section-title">失败风险</div>
      <div class="risk-tags">${riskLabels}</div>
    </div>

    <div class="detail-section-lite">
      <div class="detail-section-title">建议动作</div>
      <p class="tool-advice">${escapeHtml(adviceFor(tool))}</p>
    </div>
  `;
}

function renderScoreBar(label, value, max, negative = false) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `
    <div class="score-row ${negative ? 'negative' : ''}">
      <div class="score-row-top"><span>${label}</span><span>${value}/${max}</span></div>
      <div class="score-track"><div class="score-fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function adviceFor(tool) {
  if ((tool.error_rate || 0) >= 0.3) return '优先优化这个工具的失败原因，暂时不要沉淀进稳定工作流。';
  if ((tool.value_score || 0) >= 70) return '这是高价值工具，适合保留，并观察它常出现在哪些成功链路里。';
  if ((tool.workflow_score || 0) >= 20) return '这个工具有工作流潜力，可以从典型会话里抽取复用步骤。';
  return '继续观察它在更多任务中的表现，暂时不急着沉淀。';
}

function renderWorkflowPatterns(patterns) {
  const container = document.getElementById('workflowPatterns');
  if (!container) return;
  if (!patterns.length) {
    container.innerHTML = '<div class="text-sm text-neutral-400 py-4 text-center">暂无重复出现的工作流候选</div>';
    return;
  }
  container.innerHTML = patterns.slice(0, 6).map(pattern => `
    <div class="workflow-pattern">
      <div class="workflow-title">${escapeHtml(pattern.label || '可复用链路')}</div>
      <div class="workflow-chain">${(pattern.pattern || []).map(name => `<span>${escapeHtml(name)}</span>`).join('<b>→</b>')}</div>
      <div class="workflow-meta">${pattern.count || 0} 次 · 成功率 ${(((pattern.success_rate || 0) * 100).toFixed(0))}% · 平均 ${formatDuration(pattern.avg_duration_ms || 0)}</div>
    </div>
  `).join('');
}
