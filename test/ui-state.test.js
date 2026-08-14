const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUiState() {
  return import('../src/ui-state.mjs');
}

test('decides expand-all action from the actual visible session bodies', async () => {
  const { getExpandAllAction } = await loadUiState();

  assert.equal(getExpandAllAction([true, false, false]), 'expand');
  assert.equal(getExpandAllAction([true, true]), 'collapse');
  assert.equal(getExpandAllAction([]), 'expand');
});

test('matches call rows against the active type filter', async () => {
  const { shouldShowToolType } = await loadUiState();

  assert.equal(shouldShowToolType('bash', 'all'), true);
  assert.equal(shouldShowToolType('bash', 'bash'), true);
  assert.equal(shouldShowToolType('read', 'bash'), false);
  assert.equal(shouldShowToolType('mcp', 'mcp'), true);
});

test('filters newly rendered call rows with the existing active filter', async () => {
  const { getToolTypeDisplay } = await loadUiState();
  const rows = [
    { type: 'bash' },
    { type: 'read' },
    { type: 'bash' },
  ];

  assert.deepEqual(getToolTypeDisplay(rows, 'bash'), ['', 'none', '']);
  assert.deepEqual(getToolTypeDisplay(rows, 'all'), ['', '', '']);
});

test('matches collapsed task recap rounds against any contained tool type', async () => {
  const { shouldShowToolTypeSet } = await loadUiState();

  assert.equal(shouldShowToolTypeSet(['bash', 'read'], 'bash'), true);
  assert.equal(shouldShowToolTypeSet(['read', 'write'], 'bash'), false);
  assert.equal(shouldShowToolTypeSet(['mcp'], 'all'), true);
  assert.equal(shouldShowToolTypeSet([], 'bash'), true);
});

test('focuses overview cards by selected source while keeping all cards for all-source view', async () => {
  const { filterOverviewTools } = await loadUiState();
  const tools = [
    { tool: 'codex' },
    { tool: 'opencode' },
    { tool: 'hermes' },
  ];

  assert.deepEqual(filterOverviewTools(tools, 'all').map(tool => tool.tool), ['codex', 'opencode', 'hermes']);
  assert.deepEqual(filterOverviewTools(tools, '').map(tool => tool.tool), ['codex', 'opencode', 'hermes']);
  assert.deepEqual(filterOverviewTools(tools, 'opencode').map(tool => tool.tool), ['opencode']);
});

test('orders overview tools by saved preference before default order', async () => {
  const { orderOverviewTools } = await loadUiState();
  const tools = [
    { tool: 'pi', order: 10 },
    { tool: 'codex', order: 20 },
    { tool: 'cursor', order: 70 },
    { tool: 'unknown' },
  ];

  assert.deepEqual(orderOverviewTools(tools, []).map(tool => tool.tool), ['pi', 'codex', 'cursor', 'unknown']);
  assert.deepEqual(orderOverviewTools(tools, ['pi', 'cursor']).map(tool => tool.tool), ['pi', 'cursor', 'codex', 'unknown']);
});

test('moves tools inside a saved order without dropping unknown entries', async () => {
  const { moveToolInOrder } = await loadUiState();

  assert.deepEqual(moveToolInOrder(['codex', 'pi', 'cursor'], 'pi', 'codex'), ['pi', 'codex', 'cursor']);
  assert.deepEqual(moveToolInOrder(['codex', 'pi', 'cursor'], 'codex', 'cursor'), ['pi', 'cursor', 'codex']);
  assert.deepEqual(moveToolInOrder(['codex', 'pi'], 'missing', 'pi'), ['codex', 'pi']);
});

test('ignores stale async view requests when a newer request has started', async () => {
  const { isLatestRequest } = await loadUiState();

  assert.equal(isLatestRequest(3, 3), true);
  assert.equal(isLatestRequest(2, 3), false);
});

test('renders overview configuration lens evidence states', async () => {
  const { renderConfigLensView } = await import('../src/overview/index.js');
  const html = renderConfigLensView([{
    tool: 'codex',
    display_name: 'Codex',
    config_dir: 'C:/Users/test/.codex',
    theme: { accent: '#10b981', surface: '#ecfdf5' },
    runtime_status: {
      status: 'available',
      last_event_at: '2026-08-14T01:00:00.000Z',
    },
    reconciliation: {
      status: 'matched',
      mode: 'runtime_and_history',
      runtime_events: 3,
      history_events: 8,
      last_observed_at: '2026-08-14T01:00:00.000Z',
      details: {
        tool_calls: {
          tool_call_count: 4,
          matched_calls: 2,
          runtime_only_calls: 1,
          history_only_calls: 1,
          conflict_calls: 0,
        },
      },
    },
    config_chain: [{
      scope: 'user',
      label: 'Hook 配置',
      path: 'C:/Users/test/.codex/hooks.json',
      evidence_type: 'static_scan',
      status: 'disk_discovered',
    }],
    evidence: [
      {
        subject_type: 'hook',
        label: 'Hook 配置',
        scope: 'user',
        path: 'C:/Users/test/.codex/hooks.json',
        evidence_type: 'static_scan',
        status: 'disk_discovered',
      },
      {
        subject_type: 'mcp',
        label: 'github',
        scope: 'session',
        evidence_type: 'runtime_hook',
        visibility: 'invoked',
        status: 'invoked',
        observed_at: '2026-08-14T01:00:00.000Z',
      },
    ],
  }]);

  assert.match(html, /配置覆盖链/);
  assert.match(html, /能力证据/);
  assert.match(html, /运行时\/历史对账/);
  assert.match(html, /运行时 \+ 历史/);
  assert.match(html, /运行时事件/);
  assert.match(html, /历史\/本地事件/);
  assert.match(html, /工具已对账/);
  assert.match(html, /仅运行时/);
  assert.match(html, /仅历史/);
  assert.match(html, /冲突/);
  assert.match(html, /Hook 配置/);
  assert.match(html, /github/);
  assert.match(html, /本次调用/);
  assert.match(html, /运行时确认/);
});
