const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProjectIndex, buildPiReconciliationMap, loadTimelineItems, encodeTimelineCursor, decodeTimelineCursor, encodeSessionCursor, decodeSessionCursor } = require('../server/routes');

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

test('passes timeline cursor and one extra row to paged database query', async () => {
  const cursor = encodeTimelineCursor({
    id: 42,
    timestamp: '2026-08-14T01:00:00.000Z',
    source_sequence: 7,
  });
  let received;

  const items = await loadTimelineItems({
    session: 'codex-session-1',
    source: 'codex',
    project: 'project-1',
    limit: 2,
    cursor,
    queryTimelineFn: (options) => {
      received = options;
      return [
        { id: 43, timestamp: '2026-08-14T01:01:00.000Z', session_id: options.session_id, source: options.source },
        { id: 44, timestamp: '2026-08-14T01:02:00.000Z', session_id: options.session_id, source: options.source },
        { id: 45, timestamp: '2026-08-14T01:03:00.000Z', session_id: options.session_id, source: options.source },
      ];
    },
    getAdapterFn: () => {
      throw new Error('cursor requests should not fall back to source adapters');
    },
  });

  assert.equal(items.length, 3);
  assert.equal(received.limit, 3);
  assert.equal(received.session_id, 'codex-session-1');
  assert.equal(received.source, 'codex');
  assert.equal(received.project_key, 'project-1');
  assert.deepEqual(received.after, {
    timestamp: '2026-08-14T01:00:00.000Z',
    order: 7,
    id: 42,
  });
});

test('round-trips timeline cursor payloads', () => {
  const cursor = encodeTimelineCursor({
    id: 9,
    timestamp: '2026-08-14T02:00:00.000Z',
    seq: 3,
  });

  assert.deepEqual(decodeTimelineCursor(cursor), {
    timestamp: '2026-08-14T02:00:00.000Z',
    order: 3,
    id: 9,
  });
  assert.equal(decodeTimelineCursor('not-a-cursor'), null);
});

test('round-trips session cursor payloads', () => {
  const cursor = encodeSessionCursor({
    session_key: 'codex:session-1',
    source: 'codex',
    session_id: 'session-1',
    start_time: '2026-08-14T03:00:00.000Z',
  });

  assert.deepEqual(decodeSessionCursor(cursor), {
    startTime: '2026-08-14T03:00:00.000Z',
    key: 'codex:session-1',
  });
  assert.equal(decodeSessionCursor('not-a-cursor'), null);
});

test('builds Pi per-call reconciliation map for timeline rows', () => {
  const map = buildPiReconciliationMap([
    {
      session_id: 'pi-session',
      call_id: 'matched-call',
      runtime_count: 1,
      history_count: 2,
      runtime_success: '1',
      history_success: '1',
      last_observed_at: '2026-08-14T09:00:00.000Z',
    },
    {
      session_id: 'pi-session',
      call_id: 'runtime-only',
      runtime_count: 1,
      history_count: 0,
      runtime_success: '1',
      history_success: '',
    },
    {
      session_id: 'pi-session',
      call_id: 'conflict-call',
      runtime_count: 1,
      history_count: 1,
      runtime_success: '1',
      history_success: '0',
    },
  ]);

  assert.equal(map.get('pi-session::matched-call').status, 'matched');
  assert.equal(map.get('pi-session::matched-call').runtime_events, 1);
  assert.equal(map.get('pi-session::matched-call').history_events, 2);
  assert.equal(map.get('pi-session::runtime-only').status, 'runtime_only');
  assert.equal(map.get('pi-session::conflict-call').status, 'conflict');
  assert.equal(map.get('missing::matched-call'), undefined);
});

test('builds project index with source badges and filters by selected source', () => {
  const rows = [
    { project_key: 'p1', source: 'codex', session_count: 2, tool_count: 7, last_seen: '2026-08-10T08:00:00.000Z' },
    { project_key: 'p1', source: 'claude-code', session_count: 1, tool_count: 3, last_seen: '2026-08-10T09:00:00.000Z' },
    { project_key: 'p2', source: 'hermes', session_count: 1, tool_count: 4, last_seen: '2026-08-09T09:00:00.000Z' },
  ];
  const projects = {
    p1: { name: 'agent-lens', cwd: 'F:/agent-lens' },
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
