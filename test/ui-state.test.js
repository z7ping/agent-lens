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
