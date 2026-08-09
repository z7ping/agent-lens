const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTimelineItems } = require('../server/routes');

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
