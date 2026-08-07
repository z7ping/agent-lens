const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyToolType,
  scoreTool,
  buildToolMap,
} = require('../server/tool-map');

test('classifies skills, MCP tools, CLI, file tools, and generic tools', () => {
  assert.equal(classifyToolType('Skill'), 'skill');
  assert.equal(classifyToolType('mcp__browser__open'), 'mcp');
  assert.equal(classifyToolType('Bash'), 'cli');
  assert.equal(classifyToolType('Read'), 'file');
  assert.equal(classifyToolType('Agent'), 'agent');
  assert.equal(classifyToolType('unknown_tool'), 'tool');
});

test('scores a frequently used workflow-friendly tool with explainable components', () => {
  const score = scoreTool({
    tool_name: 'Edit',
    call_count: 40,
    session_count: 10,
    success_count: 36,
    error_count: 4,
    avg_duration_ms: 900,
    successful_session_count: 10,
    common_pair_count: 12,
    terminal_success_count: 10,
    risk_labels: ['path_not_found'],
  }, { maxCalls: 40, maxSessions: 10, maxPairCount: 12 });

  assert.equal(score.frequency_score, 40);
  assert.equal(score.workflow_score, 35);
  assert.equal(score.time_saving_score, 24);
  assert.equal(score.risk_penalty, 15);
  assert.equal(score.value_score, 84);
  assert.equal(score.recommendation, '保留');
  assert.ok(score.explanations.some(text => text.includes('覆盖 10 个会话')));
  assert.ok(score.explanations.some(text => text.includes('常见失败类型')));
});

test('builds a sorted tool map summary and flags high risk tools', () => {
  const rows = [
    { id: 1, session_id: 's1', source: 'codex', tool_name: 'Bash', role: 'tool_result', success: 1, duration_ms: 1000, timestamp: '2026-08-07T01:00:00Z' },
    { id: 2, session_id: 's1', source: 'codex', tool_name: 'Read', role: 'tool_result', success: 1, duration_ms: 200, timestamp: '2026-08-07T01:00:01Z' },
    { id: 3, session_id: 's1', source: 'codex', tool_name: 'Edit', role: 'tool_result', success: 1, duration_ms: 300, timestamp: '2026-08-07T01:00:02Z' },
    { id: 4, session_id: 's2', source: 'codex', tool_name: 'Bash', role: 'tool_error', success: 0, duration_ms: 5000, error_type: 'timeout', timestamp: '2026-08-07T02:00:00Z' },
    { id: 5, session_id: 's2', source: 'codex', tool_name: 'Read', role: 'tool_result', success: 1, duration_ms: 220, timestamp: '2026-08-07T02:00:01Z' },
    { id: 6, session_id: 's2', source: 'codex', tool_name: 'Edit', role: 'tool_result', success: 1, duration_ms: 330, timestamp: '2026-08-07T02:00:02Z' },
    { id: 7, session_id: 's3', source: 'hermes', tool_name: 'mcp__browser__open', role: 'tool_result', success: 1, duration_ms: 800, timestamp: '2026-08-07T03:00:00Z' },
  ];

  const result = buildToolMap(rows);

  assert.equal(result.summary.total_tools, 4);
  assert.equal(result.summary.high_risk_tools, 1);
  assert.ok(result.summary.workflow_candidates >= 1);
  assert.equal(result.items[0].value_score >= result.items[1].value_score, true);

  const bash = result.items.find(item => item.tool_name === 'Bash');
  assert.equal(bash.call_count, 2);
  assert.equal(bash.error_count, 1);
  assert.deepEqual(bash.risk_labels, ['timeout']);
  assert.ok(Array.isArray(result.workflow_patterns));
});
