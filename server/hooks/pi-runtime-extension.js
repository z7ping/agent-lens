#!/usr/bin/env node
/**
 * Pi runtime extension bridge for AgentLens.
 *
 * This module is intentionally passive: requiring it does not modify Pi state.
 * A Pi host can call registerPiRuntimeExtension(api) when it exposes an event API,
 * or call sendPiRuntimeEvent(event) directly from its own extension hooks.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 56789;
const DEFAULT_RUNTIME_EVENTS = [
  'session_start',
  'before_agent_start',
  'agent_end',
  'session_before_compact',
  'session_compact',
  'session_shutdown',
  'tool_call',
  'tool_result',
];

const PI_NATIVE_EVENT_TYPES = {
  session_start: 'session_start',
  before_agent_start: 'user_prompt',
  agent_end: 'turn_stop',
  session_before_compact: 'compact_start',
  session_compact: 'compact_end',
  session_shutdown: 'session_end',
  tool_call: 'tool_use',
  tool_result: 'tool_result',
};

function defaultInstallRoot(homeDir = os.homedir()) {
  return path.join(homeDir, '.agent-lens');
}

function resolveHookToken(options = {}) {
  if (options.token) return String(options.token);
  if (process.env.AGENT_LENS_HOOK_TOKEN) return process.env.AGENT_LENS_HOOK_TOKEN;

  const rootDir = options.rootDir || process.env.AGENT_LENS_HOME || defaultInstallRoot(options.homeDir);
  const tokenFile = options.tokenFile || path.join(rootDir, 'run', 'hook-token');
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function resolveHookUrl(options = {}) {
  if (options.url) return String(options.url);
  if (process.env.AGENT_LENS_HOOK_URL) return process.env.AGENT_LENS_HOOK_URL;
  const port = options.port || process.env.AGENT_LENS_PORT || DEFAULT_PORT;
  return `http://127.0.0.1:${port}/api/hook`;
}

function normalizeRuntimeEventType(event = {}) {
  const raw = String(event.event_type || event.runtime_event_type || event.type || '').trim().toLowerCase();
  const aliases = {
    before_agent_start: 'user_prompt',
    input: 'user_prompt',
    user_message: 'user',
    message: event.role === 'assistant' ? 'assistant' : 'user_prompt',
    assistant_message: 'assistant',
    response: 'assistant',
    tool: 'tool_use',
    tool_call: 'tool_use',
    call: 'tool_use',
    result: 'tool_result',
    tool_response: 'tool_result',
    error: 'tool_error',
    summary: 'compact_end',
    compaction: 'compact_end',
    session_start: 'session_start',
    session_before_compact: 'compact_start',
    session_compact: 'compact_end',
    session_end: 'session_end',
    session_shutdown: 'session_end',
    agent_end: 'turn_stop',
  };
  return aliases[raw] || raw || 'event';
}

function safeString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function safeCall(fn) {
  if (typeof fn !== 'function') return '';
  try {
    return safeString(fn(), '');
  } catch (_) {
    return '';
  }
}

function normalizePiSessionId(value) {
  const text = safeString(value, '');
  if (!text) return '';
  const withoutPrefix = text.startsWith('pi:') ? text.slice(3) : text;
  const uuidMatch = withoutPrefix.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  return withoutPrefix;
}

function readPiSessionId(ctx = {}) {
  const manager = ctx && ctx.sessionManager;
  const candidates = [
    safeString(ctx.session_id || ctx.sessionId, ''),
    safeCall(manager && manager.getSessionId && manager.getSessionId.bind(manager)),
    safeCall(manager && manager.getSessionFile && manager.getSessionFile.bind(manager)),
  ];
  for (const candidate of candidates) {
    const sessionId = normalizePiSessionId(candidate);
    if (sessionId) return sessionId;
  }
  return 'default';
}

function readPiCwd(ctx = {}) {
  return safeString(ctx.cwd, '') || process.cwd();
}

function pickContent(event = {}) {
  if (!event || typeof event !== 'object') return null;
  const value = event.content ?? event.text ?? event.prompt ?? event.message ?? event.summary ?? null;
  if (typeof value === 'string') return value;
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function buildPiHostRuntimeEvent(nativeName, nativeEvent = {}, ctx = {}, defaults = {}) {
  const eventType = PI_NATIVE_EVENT_TYPES[nativeName] || normalizeRuntimeEventType({ type: nativeName });
  const isToolError = nativeName === 'tool_result' && Boolean(nativeEvent && nativeEvent.isError);
  const toolCallId = nativeEvent.toolCallId || nativeEvent.tool_call_id || nativeEvent.call_id || nativeEvent.tool_use_id || '';
  const payload = buildPiRuntimeEventPayload({
    source_event_id: nativeEvent.id || nativeEvent.entryId || nativeEvent.event_id || `${nativeName}:${Date.now()}`,
    event_type: isToolError ? 'tool_error' : eventType,
    native_event_type: nativeName,
    session_id: readPiSessionId(ctx),
    cwd: readPiCwd(ctx),
    tool_call_id: toolCallId,
    call_id: toolCallId,
    tool_name: nativeEvent.toolName || nativeEvent.tool_name || nativeEvent.name || '',
    tool_input: nativeEvent.inputSummary || nativeEvent.input_summary || nativeEvent.input || nativeEvent.toolInput || null,
    output_snippet: nativeEvent.outputSnippet || nativeEvent.output_snippet || nativeEvent.output || nativeEvent.result || null,
    content: pickContent(nativeEvent),
    duration_ms: nativeEvent.durationMs ?? nativeEvent.duration_ms ?? null,
    success: nativeName === 'tool_result' ? !nativeEvent.isError : nativeEvent.success,
    attributes: {
      pi_native_event: nativeName,
      ...(nativeEvent.attributes && typeof nativeEvent.attributes === 'object' ? nativeEvent.attributes : {}),
    },
  }, defaults);
  return payload;
}

function buildPiRuntimeEventPayload(event = {}, defaults = {}) {
  const payload = {
    ...defaults,
    ...event,
    source: 'pi',
    event_type: normalizeRuntimeEventType(event),
  };
  if (!payload.timestamp) payload.timestamp = new Date().toISOString();
  if (!payload.cwd && defaults.cwd) payload.cwd = defaults.cwd;
  if (!payload.session_id && defaults.session_id) payload.session_id = defaults.session_id;
  if (!payload.tool_call_id && payload.call_id) payload.tool_call_id = payload.call_id;
  return payload;
}

function postJson(urlText, token, payload, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(urlText);
    const body = JSON.stringify(payload);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      method: 'POST',
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      timeout: options.timeoutMs || 2000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AgentLens-Token': token,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, statusCode: res.statusCode, body: text });
        else reject(new Error(`AgentLens hook rejected Pi event with HTTP ${res.statusCode}: ${text}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('AgentLens hook request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function sendPiRuntimeEvent(event = {}, options = {}) {
  const token = resolveHookToken(options);
  if (!token) return { ok: false, skipped: true, reason: 'missing_hook_token' };
  const payload = buildPiRuntimeEventPayload(event, options.defaults || {});
  return postJson(resolveHookUrl(options), token, payload, options);
}

function registerPiRuntimeExtension(api, options = {}) {
  if (!api || typeof api.on !== 'function') {
    return { registered: false, reason: 'missing_event_api' };
  }
  const events = options.events || DEFAULT_RUNTIME_EVENTS;
  const registered = [];
  for (const eventName of events) {
    api.on(eventName, (event, ctx) => {
      const payload = buildPiHostRuntimeEvent(eventName, event, ctx, options.defaults || {});
      const task = sendPiRuntimeEvent(payload, { ...options, defaults: {} });
      if (eventName === 'agent_end' || eventName === 'session_shutdown') return task.catch(() => {});
      task.catch(() => {});
      return undefined;
    });
    registered.push(eventName);
  }
  return { registered: true, events: registered };
}

function agentLensPiExtension(api) {
  registerPiRuntimeExtension(api);
}

Object.assign(agentLensPiExtension, {
  DEFAULT_RUNTIME_EVENTS,
  PI_NATIVE_EVENT_TYPES,
  agentLensPiExtension,
  buildPiHostRuntimeEvent,
  buildPiRuntimeEventPayload,
  normalizeRuntimeEventType,
  normalizePiSessionId,
  registerPiRuntimeExtension,
  resolveHookToken,
  resolveHookUrl,
  sendPiRuntimeEvent,
});
module.exports = agentLensPiExtension;
module.exports.default = agentLensPiExtension;
