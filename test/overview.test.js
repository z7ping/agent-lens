const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const {
  buildOverview,
  readOverviewInventory,
  refreshOverviewInventory,
} = require('../server/overview');

test('builds one overview card per tool with grouped capability assets', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        config_dir: 'C:/Users/test/.codex',
        version: '1.0.0',
        assets: [
          { name: 'superpowers:brainstorming', type: 'skill', status: 'enabled', path: 'C:/Users/test/.codex/skills/superpowers/brainstorming' },
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser' },
        ],
      },
      {
        tool: 'cursor',
        display_name: 'Cursor',
        config_dir: 'C:/Users/test/AppData/Roaming/Cursor/User',
        assets: [
          { name: 'browser', type: 'extension', status: 'enabled', path: 'C:/Users/test/.cursor/extensions/browser' },
        ],
      },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'superpowers:brainstorming', call_count: 8 },
      { source: 'codex', tool_name: 'browser', call_count: 3 },
      { source: 'cursor', tool_name: 'browser', call_count: 2 },
    ],
    priorityThreshold: 5,
  });

  assert.equal(overview.tools.length, 2);
  assert.equal(overview.tools[0].tool, 'codex');
  assert.equal(overview.tools[0].theme.accent, '#10b981');
  assert.equal(overview.tools[0].asset_groups.skill.count, 1);
  assert.equal(overview.tools[0].asset_groups.plugin.count, 1);

  const brainstorming = overview.tools[0].assets.find(asset => asset.name === 'superpowers:brainstorming');
  assert.equal(brainstorming.call_count, 8);
  assert.equal(brainstorming.is_priority, true);
});

test('builds a capability matrix for high-frequency assets across tools', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        assets: [
          { name: 'github', type: 'mcp', status: 'configured' },
          { name: 'superpowers:brainstorming', type: 'skill', status: 'enabled' },
        ],
      },
      {
        tool: 'claude-code',
        display_name: 'Claude Code',
        assets: [
          { name: 'github', type: 'mcp', status: 'configured' },
        ],
      },
      {
        tool: 'cursor',
        display_name: 'Cursor',
        assets: [],
      },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'github', call_count: 10 },
      { source: 'codex', tool_name: 'superpowers:brainstorming', call_count: 9 },
    ],
    priorityThreshold: 5,
  });

  assert.deepEqual(overview.priority_assets.map(asset => asset.name), ['github', 'superpowers:brainstorming']);

  const github = overview.capability_matrix.find(row => row.name === 'github');
  assert.equal(github.coverage.codex.status, '已有');
  assert.equal(github.coverage['claude-code'].status, '已有');
  assert.equal(github.coverage.cursor.status, '缺失');

  const brainstorming = overview.capability_matrix.find(row => row.name === 'superpowers:brainstorming');
  assert.equal(brainstorming.coverage.codex.status, '已有');
  assert.equal(brainstorming.coverage['claude-code'].status, '缺失');
});

test('adds frequently used timeline-only assets to the owning tool card', () => {
  const overview = buildOverview({
    inventory: [
      { tool: 'codex', display_name: 'Codex', assets: [] },
      { tool: 'cursor', display_name: 'Cursor', assets: [] },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'Bash', call_count: 12 },
      { source: 'cursor', tool_name: 'Bash', call_count: 2 },
    ],
    priorityThreshold: 5,
  });

  const codex = overview.tools.find(tool => tool.tool === 'codex');
  const bash = codex.assets.find(asset => asset.name === 'Bash');

  assert.equal(bash.type, 'builtin');
  assert.equal(bash.status, 'observed');
  assert.equal(bash.call_count, 12);
  assert.equal(bash.is_priority, true);

  const row = overview.capability_matrix.find(item => item.name === 'Bash');
  assert.equal(row.coverage.codex.status, '已有');
  assert.equal(row.coverage.cursor.status, '已有');
});

test('persists stable overview inventory in the agent trace database', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-07T00:00:00.000Z',
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        version: '1.2.3',
        status: 'detected',
        config_dir: 'C:/Users/test/.codex',
        theme: { accent: '#10b981', surface: '#ecfdf5' },
        assets: [
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser', description: 'Browser control' },
        ],
      },
    ],
  });

  const inventory = readOverviewInventory(db);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].tool, 'codex');
  assert.equal(inventory[0].version, '1.2.3');
  assert.equal(inventory[0].theme.accent, '#10b981');
  assert.equal(inventory[0].assets.length, 1);
  assert.equal(inventory[0].assets[0].name, 'browser');

  const run = db.prepare('SELECT status, tool_count, asset_count FROM overview_scan_runs ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual(run, { status: 'success', tool_count: 1, asset_count: 1 });
});

test('queryOverview reads cached inventory from database and merges timeline usage', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-07T00:00:00.000Z',
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        version: '1.2.3',
        status: 'detected',
        config_dir: 'C:/Users/test/.codex',
        assets: [
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser' },
        ],
      },
    ],
  });
  db.prepare(`
    INSERT INTO timeline (source, session_id, timestamp, role, tool_name, success)
    VALUES ('codex', 's1', '2026-08-07T00:00:01.000Z', 'tool_result', 'browser', 1)
  `).run();
  db.prepare(`
    INSERT INTO timeline (source, session_id, timestamp, role, tool_name, success)
    VALUES ('codex', 's2', '2026-08-07T00:00:02.000Z', 'tool_result', 'browser', 1)
  `).run();

  const { queryOverview } = require('../server/overview');
  const overview = queryOverview(db, { priorityThreshold: 2 });
  const browser = overview.tools[0].assets.find(asset => asset.name === 'browser');

  assert.equal(overview.tools[0].version, '1.2.3');
  assert.equal(browser.call_count, 2);
  assert.equal(browser.is_priority, true);
  assert.equal(overview.capability_matrix[0].name, 'browser');
});
