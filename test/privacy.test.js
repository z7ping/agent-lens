const test = require('node:test');
const assert = require('node:assert/strict');

const { REDACTED, getCapturePolicy, redactValue, sanitizeEventRecord, captureEnvironment, captureConfigValue } = require('../server/privacy');

test('递归脱敏凭据字段和常见 Token 文本', () => {
  const result = redactValue({
    api_key: 'sk-test-abcdefghijklmnopqrstuvwxyz',
    nested: { authorization: 'Bearer abc.def.ghi', note: 'token=secret-value' },
  });
  assert.equal(result.value.api_key, REDACTED);
  assert.equal(result.value.nested.authorization, REDACTED);
  assert.match(result.value.nested.note, /已脱敏/);
  assert.equal(result.redactionApplied, true);
});

test('事件入库前按默认策略脱敏提示词和工具数据', () => {
  const safe = sanitizeEventRecord({
    role: 'user',
    content: '请使用 api_key=very-secret-value',
    tool_input: JSON.stringify({ password: 'hidden', path: 'F:/project' }),
  }, {});
  assert.doesNotMatch(safe.content, /very-secret-value/);
  assert.doesNotMatch(safe.tool_input, /hidden/);
  assert.equal(safe.redaction_applied, 1);
});

test('环境信息默认关闭，启用后也只采集允许名单', () => {
  assert.equal(getCapturePolicy({}).environment, 'off');
  assert.equal(captureEnvironment({ LANG: 'zh_CN', SECRET_TOKEN: 'nope' }, {}).value, null);
  const captured = captureEnvironment(
    { LANG: 'zh_CN', SAFE_CUSTOM: 'yes', SECRET_TOKEN: 'nope' },
    { AGENT_LENS_ENV_CAPTURE: 'redacted', AGENT_LENS_ENV_ALLOWLIST: 'SAFE_CUSTOM' },
  );
  assert.deepEqual(captured.value, { LANG: 'zh_CN', SAFE_CUSTOM: 'yes' });
});

test('配置采集开关支持关闭、脱敏和显式完整模式', () => {
  assert.equal(captureConfigValue('token=config-secret', { AGENT_LENS_CONFIG_CAPTURE: 'off' }).value, null);
  assert.doesNotMatch(captureConfigValue('token=config-secret', {}).value, /config-secret/);
  assert.equal(captureConfigValue('token=config-secret', { AGENT_LENS_CONFIG_CAPTURE: 'full' }).value, 'token=config-secret');
});
