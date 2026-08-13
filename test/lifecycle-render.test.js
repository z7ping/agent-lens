const test = require('node:test');
const assert = require('node:assert/strict');

test('来源无关生命周期视图展示 Pi 原生日志语义', async () => {
  global.window = global.window || {};
  const { renderCallChainCalls } = await import('../src/callchain/index.js');
  const html = renderCallChainCalls([
    {
      source: 'pi', session_id: 'pi-session', event_type: 'session_start', role: 'session_start',
      timestamp: '2026-08-13T00:00:00.000Z', capture_method: 'native_log', confidence: 'confirmed',
      attributes_json: JSON.stringify({ parent_session_id: 'pi-parent' }),
    },
    {
      source: 'pi', session_id: 'pi-session', event_type: 'model_change', role: 'model_change',
      timestamp: '2026-08-13T00:00:01.000Z', capture_method: 'native_log', confidence: 'confirmed',
      attributes_json: JSON.stringify({ provider: 'openai', model: 'gpt-test' }),
    },
    {
      source: 'pi', session_id: 'pi-session', event_type: 'compact_end', role: 'compact_end',
      timestamp: '2026-08-13T00:00:02.000Z', capture_method: 'native_log', confidence: 'confirmed',
      content: '压缩摘要', attributes_json: JSON.stringify({ tokens_before: 50000 }),
    },
  ]);

  assert.match(html, /Pi 生命周期/);
  assert.match(html, /原生日志/);
  assert.match(html, /模型切换/);
  assert.match(html, /openai\/gpt-test/);
  assert.match(html, /压缩前 50000 tokens/);
  assert.doesNotMatch(html, /Codex 生命周期/);
});
