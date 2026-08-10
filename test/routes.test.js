const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProjectIndex, loadTimelineItems } = require('../server/routes');

test('falls back to source adapter records when timeline database has no rows', async () => {
  const items = await loadTimelineItems({
    session: 'hermes-session-1',
    source: 'hermes',
    project: '',
    limit: 20,
    queryTimelineFn: () => [],
    getAdapterFn: () => ({
      getRecords: async (filter) => [
        {
          ts: '2026-08-10T00:00:00.000Z',
          session_id: filter.session_id,
          source: filter.source,
          tool_name: 'Bash',
          success: true,
        },
      ],
    }),
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].session_id, 'hermes-session-1');
  assert.equal(items[0].source, 'hermes');
  assert.equal(items[0].role, 'tool_result');
  assert.equal(items[0].tool_name, 'Bash');
});

test('builds project index with source badges and filters by selected source', () => {
  const rows = [
    { project_key: 'p1', source: 'codex', session_count: 2, tool_count: 7, last_seen: '2026-08-10T08:00:00.000Z' },
    { project_key: 'p1', source: 'claude-code', session_count: 1, tool_count: 3, last_seen: '2026-08-10T09:00:00.000Z' },
    { project_key: 'p2', source: 'hermes', session_count: 1, tool_count: 4, last_seen: '2026-08-09T09:00:00.000Z' },
  ];
  const projects = {
    p1: { name: 'agent-trace', cwd: 'F:/agent-trace' },
    p2: { name: 'demo-app', cwd: 'F:/demo-app' },
  };

  const all = buildProjectIndex(rows, projects);
  assert.equal(all.items.length, 2);
  assert.equal(all.items[0].project_key, 'p1');
  assert.deepEqual(all.items[0].sources.map(item => item.source), ['claude-code', 'codex']);
  assert.equal(all.items[0].source_label, 'Claude Code CLI · Codex');
  assert.equal(all.items[0].session_count, 3);
  assert.equal(all.items[0].tool_count, 10);

  const codexOnly = buildProjectIndex(rows, projects, { source: 'codex' });
  assert.deepEqual(codexOnly.items.map(item => item.project_key), ['p1']);
  assert.deepEqual(codexOnly.items[0].sources.map(item => item.source), ['codex']);
  assert.equal(codexOnly.items[0].source_label, 'Codex');
});
