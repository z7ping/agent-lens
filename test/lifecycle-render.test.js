const test = require('node:test');
const assert = require('node:assert/strict');

function event(role, overrides = {}) {
  return {
    source: 'codex',
    session_id: 'session',
    event_type: role,
    role,
    capture_method: 'native_log',
    confidence: 'confirmed',
    ...overrides,
  };
}

async function render(events) {
  global.window = global.window || {};
  const { renderCallChainCalls } = await import('../src/callchain/index.js');
  return renderCallChainCalls(events);
}

function count(html, token) {
  return html.split(token).length - 1;
}

test('重复采集的对话只渲染一次，工具保持在过程回复和最终回复之间', async () => {
  const prompt = '统一展示完整执行周期';
  const finalReply = '执行流已经生成';
  const html = await render([
    event('user', { content: prompt }),
    event('user_prompt', { content: prompt, turn_id: 'turn-1', capture_method: 'runtime_hook' }),
    event('assistant', { content: '先检查事件归属' }),
    event('tool_use', { tool_name: 'bash', call_id: 'call-1', turn_id: 'turn-1' }),
    event('tool_result', { tool_name: 'bash', call_id: 'call-1', turn_id: 'turn-1', success: 1 }),
    event('assistant', { content: finalReply }),
    event('turn_stop', { content: finalReply, turn_id: 'turn-1', capture_method: 'runtime_hook' }),
  ]);

  assert.equal(count(html, 'chat-message user'), 1);
  assert.equal(count(html, 'chat-message assistant'), 2);
  assert.equal(count(html, 'flow-tools'), 1);

  const user = html.indexOf('chat-message user');
  const processReply = html.indexOf('chat-message assistant');
  const tools = html.indexOf('flow-tools');
  const final = html.lastIndexOf('chat-message assistant');
  assert.ok(user < processReply && processReply < tools && tools < final);
});

test('Pi thinking 只展示来源可见元数据，不渲染正文', async () => {
  const hiddenThinking = '不应出现在界面中的 thinking 正文';
  const html = await render([
    event('user', { source: 'pi', content: '检查思考证据边界', turn_id: 'turn-1' }),
    event('assistant', {
      source: 'pi',
      content: '这是来源提供的普通回复',
      turn_id: 'turn-1',
      attributes_json: JSON.stringify({
        thinking_present: true,
        thinking_blocks: 2,
        thinking_text: hiddenThinking,
      }),
    }),
  ]);

  assert.equal(count(html, 'thinking-observed'), 1);
  assert.match(html, /2 个来源可见块/);
  assert.doesNotMatch(html, new RegExp(hiddenThinking));
  assert.ok(html.indexOf('thinking-observed') < html.indexOf('chat-message assistant'));
});

test('压缩恢复产生的会话事件位于前后两个 Turn 之间', async () => {
  const html = await render([
    event('user', { content: '第一轮', turn_id: 'turn-1' }),
    event('turn_stop', { turn_id: 'turn-1', capture_method: 'runtime_hook' }),
    event('session_start', {
      capture_method: 'runtime_hook',
      attributes_json: JSON.stringify({ start_source: 'compact' }),
    }),
    event('user', { content: '第二轮', turn_id: 'turn-2' }),
  ]);

  assert.equal(count(html, 'round-block'), 2);
  assert.equal(count(html, 'session-flow-events between'), 1);

  const firstRound = html.indexOf('round-block');
  const resumeEvent = html.indexOf('session-flow-events between');
  const secondRound = html.indexOf('round-block', firstRound + 1);
  assert.ok(firstRound < resumeEvent && resumeEvent < secondRound);
});
