const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const REDACTED = '[已脱敏]';
const DEFAULT_MAX_TEXT = 20000;
const DEFAULT_MAX_TOOL_TEXT = 4000;
const DEFAULT_ENV_ALLOWLIST = ['LANG', 'LC_ALL', 'SHELL', 'TERM', 'OS', 'PROCESSOR_ARCHITECTURE'];

function normalizeCaptureMode(value, fallback = 'redacted') {
  const mode = String(value || '').trim().toLowerCase();
  return ['off', 'redacted', 'full'].includes(mode) ? mode : fallback;
}

function getCapturePolicy(env = process.env) {
  return {
    prompt: normalizeCaptureMode(env.AGENT_LENS_PROMPT_CAPTURE, 'redacted'),
    tool: normalizeCaptureMode(env.AGENT_LENS_TOOL_CAPTURE, 'redacted'),
    config: normalizeCaptureMode(env.AGENT_LENS_CONFIG_CAPTURE, 'redacted'),
    environment: normalizeCaptureMode(env.AGENT_LENS_ENV_CAPTURE, 'off'),
  };
}

function redactText(input) {
  let value = String(input ?? '');
  const original = value;

  value = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${REDACTED}`)
    .replace(/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/gi, REDACTED)
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/([?&](?:token|access_token|api_key|key|secret|password)=)[^&#\s]+/gi, `$1${encodeURIComponent(REDACTED)}`)
    .replace(/\b(authorization|cookie|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*([^\s,;]+)/gi, `$1=${REDACTED}`);

  return { value, redactionApplied: value !== original };
}

function redactValue(input, options = {}, seen = new WeakSet()) {
  const maxText = Number.isFinite(options.maxText) ? options.maxText : DEFAULT_MAX_TEXT;

  if (input === null || input === undefined) return { value: input, redactionApplied: false };
  if (typeof input === 'string') {
    const redacted = redactText(input.slice(0, maxText));
    return {
      value: redacted.value,
      redactionApplied: redacted.redactionApplied,
    };
  }
  if (typeof input !== 'object') return { value: input, redactionApplied: false };
  if (seen.has(input)) return { value: '[循环引用]', redactionApplied: true };
  seen.add(input);

  let redactionApplied = false;
  if (Array.isArray(input)) {
    const value = input.slice(0, 100).map(item => {
      const result = redactValue(item, options, seen);
      redactionApplied = redactionApplied || result.redactionApplied;
      return result.value;
    });
    if (input.length > value.length) redactionApplied = true;
    seen.delete(input);
    return { value, redactionApplied };
  }

  const value = {};
  for (const [key, item] of Object.entries(input).slice(0, 100)) {
    if (SENSITIVE_KEY.test(key)) {
      value[key] = REDACTED;
      redactionApplied = true;
      continue;
    }
    const result = redactValue(item, options, seen);
    value[key] = result.value;
    redactionApplied = redactionApplied || result.redactionApplied;
  }
  if (Object.keys(input).length > Object.keys(value).length) redactionApplied = true;
  seen.delete(input);
  return { value, redactionApplied };
}

function applyCaptureMode(value, mode, options = {}) {
  if (mode === 'off') return { value: null, redactionApplied: value != null, capturePolicy: 'off' };
  if (mode === 'full') {
    const limited = redactValue(value, { ...options, redact: false });
    return { value: limited.value, redactionApplied: false, capturePolicy: 'full' };
  }
  const result = redactValue(value, options);
  return { ...result, capturePolicy: 'redacted' };
}

function limitFullValue(value, maxText) {
  if (typeof value === 'string') return value.slice(0, maxText);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => limitFullValue(item, maxText));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, limitFullValue(item, maxText)]));
  }
  return value;
}

function captureValue(value, mode, options = {}) {
  const normalizedMode = normalizeCaptureMode(mode);
  const maxText = Number.isFinite(options.maxText) ? options.maxText : DEFAULT_MAX_TEXT;
  if (normalizedMode === 'off') return { value: null, redactionApplied: value != null, capturePolicy: 'off' };
  if (normalizedMode === 'full') {
    return { value: limitFullValue(value, maxText), redactionApplied: false, capturePolicy: 'full' };
  }
  const result = redactValue(value, { maxText });
  return { ...result, capturePolicy: 'redacted' };
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return { value, serialized: false };
  try {
    return { value: JSON.parse(value), serialized: true };
  } catch {
    return { value, serialized: false };
  }
}

function restoreMaybeJson(result, serialized) {
  if (!serialized || result.value === null) return result;
  return { ...result, value: JSON.stringify(result.value) };
}

function sanitizeEventRecord(record, env = process.env) {
  const policy = getCapturePolicy(env);
  const role = record.role || record.event_type || '';
  const promptMode = ['user', 'assistant', 'system'].includes(role) ? policy.prompt : policy.tool;
  const content = captureValue(record.content, promptMode, { maxText: DEFAULT_MAX_TEXT });
  const parsedToolInput = parseMaybeJson(record.tool_input);
  const toolInput = restoreMaybeJson(captureValue(parsedToolInput.value, policy.tool, { maxText: DEFAULT_MAX_TOOL_TEXT }), parsedToolInput.serialized);
  const output = captureValue(record.output_snippet, policy.tool, { maxText: DEFAULT_MAX_TOOL_TEXT });
  const error = captureValue(record.error_message, policy.tool, { maxText: DEFAULT_MAX_TOOL_TEXT });
  const parsedDetail = parseMaybeJson(record.error_detail);
  const errorDetail = restoreMaybeJson(captureValue(parsedDetail.value, policy.tool, { maxText: DEFAULT_MAX_TOOL_TEXT }), parsedDetail.serialized);
  const redactionApplied = [content, toolInput, output, error, errorDetail].some(item => item.redactionApplied);

  return {
    ...record,
    content: content.value,
    tool_input: toolInput.value,
    output_snippet: output.value,
    error_message: error.value,
    error_detail: errorDetail.value,
    redaction_applied: record.redaction_applied != null ? record.redaction_applied : (redactionApplied ? 1 : 0),
    capture_policy: record.capture_policy || (promptMode === policy.tool ? policy.tool : `${promptMode}/${policy.tool}`),
  };
}

function sanitizeLogRecord(record, env = process.env) {
  const policy = getCapturePolicy(env);
  const result = captureValue(record, policy.tool, { maxText: DEFAULT_MAX_TOOL_TEXT });
  return result.value || {};
}

function captureEnvironment(sourceEnv = process.env, policyEnv = process.env) {
  const policy = getCapturePolicy(policyEnv);
  if (policy.environment === 'off') return { value: null, redactionApplied: false, capturePolicy: 'off' };
  const allowlist = new Set([
    ...DEFAULT_ENV_ALLOWLIST,
    ...String(policyEnv.AGENT_LENS_ENV_ALLOWLIST || '').split(',').map(item => item.trim()).filter(Boolean),
  ]);
  const selected = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(sourceEnv, key)) selected[key] = sourceEnv[key];
  }
  return captureValue(selected, policy.environment, { maxText: 1000 });
}

function captureConfigValue(value, policyEnv = process.env, options = {}) {
  const policy = getCapturePolicy(policyEnv);
  return captureValue(value, policy.config, { maxText: options.maxText || DEFAULT_MAX_TOOL_TEXT });
}

module.exports = {
  REDACTED,
  SENSITIVE_KEY,
  normalizeCaptureMode,
  getCapturePolicy,
  redactText,
  redactValue,
  captureValue,
  sanitizeEventRecord,
  sanitizeLogRecord,
  captureEnvironment,
  captureConfigValue,
  DEFAULT_ENV_ALLOWLIST,
};
