const crypto = require('crypto');

const CAPTURE_METHODS = new Set([
  'runtime_hook',
  'native_log',
  'local_database',
  'cli_diagnostic',
  'static_scan',
  'inference',
  'legacy_import',
]);

const VISIBILITY_LEVELS = new Set(['captured', 'discovered', 'inferred', 'unobservable']);
const CONFIDENCE_LEVELS = new Set(['confirmed', 'partial', 'unknown']);

function normalizeSource(source) {
  const value = String(source || '').trim();
  return value || 'unknown';
}

function makeSessionKey(source, sessionId) {
  return `${normalizeSource(source)}:${String(sessionId || '')}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function eventFingerprint(record) {
  return JSON.stringify(canonicalize({
    source: normalizeSource(record.source),
    session_key: record.session_key || makeSessionKey(record.source, record.session_id),
    event_type: record.event_type || record.role || 'notification',
    source_sequence: record.source_sequence ?? record.seq ?? null,
    call_id: record.call_id || record.tool_use_id || null,
    timestamp: record.timestamp || record.ts || '',
    tool_name: record.tool_name || null,
    content: record.content || null,
    tool_input: record.tool_input || null,
  }));
}

function makeEventId(record) {
  if (record.event_id) return String(record.event_id);
  const source = normalizeSource(record.source);
  const sessionKey = record.session_key || makeSessionKey(source, record.session_id);
  const eventType = record.event_type || record.role || 'notification';
  let identity;

  if (record.source_event_id) {
    identity = `${source}|${sessionKey}|native|${record.source_event_id}|${eventType}`;
  } else if (record.call_id || record.tool_use_id) {
    identity = `${source}|${sessionKey}|call|${record.call_id || record.tool_use_id}|${eventType}`;
  } else if (record.source_sequence !== null && record.source_sequence !== undefined) {
    identity = `${source}|${sessionKey}|seq|${record.source_sequence}|${eventType}`;
  } else if (record.seq !== null && record.seq !== undefined) {
    identity = `${source}|${sessionKey}|hook-seq|${record.seq}|${eventType}`;
  } else {
    identity = eventFingerprint(record);
  }

  return `evt_${stableHash(identity).slice(0, 32)}`;
}

function normalizeEvidence(record = {}, defaults = {}) {
  const captureMethod = CAPTURE_METHODS.has(record.capture_method)
    ? record.capture_method
    : (CAPTURE_METHODS.has(defaults.capture_method) ? defaults.capture_method : 'legacy_import');
  const visibility = VISIBILITY_LEVELS.has(record.visibility)
    ? record.visibility
    : (VISIBILITY_LEVELS.has(defaults.visibility) ? defaults.visibility : 'captured');
  const confidence = CONFIDENCE_LEVELS.has(record.confidence)
    ? record.confidence
    : (CONFIDENCE_LEVELS.has(defaults.confidence) ? defaults.confidence : 'confirmed');

  return {
    capture_method: captureMethod,
    visibility,
    confidence,
    missing_reason: record.missing_reason || defaults.missing_reason || null,
  };
}

function normalizeEventRecord(record = {}, defaults = {}) {
  const source = normalizeSource(record.source || defaults.source);
  const sessionId = String(record.session_id || defaults.session_id || '');
  const sessionKey = record.session_key || makeSessionKey(source, sessionId);
  const eventType = record.event_type || record.role || defaults.event_type || 'notification';
  const callId = record.call_id || record.tool_use_id || null;
  const normalized = {
    ...record,
    source,
    session_id: sessionId,
    session_key: sessionKey,
    role: record.role || eventType,
    event_type: eventType,
    call_id: callId,
    tool_use_id: record.tool_use_id || callId,
    source_sequence: record.source_sequence ?? record.seq ?? null,
    ...normalizeEvidence(record, defaults),
  };
  normalized.event_id = makeEventId(normalized);
  return normalized;
}

module.exports = {
  CAPTURE_METHODS,
  VISIBILITY_LEVELS,
  CONFIDENCE_LEVELS,
  normalizeSource,
  makeSessionKey,
  makeEventId,
  normalizeEvidence,
  normalizeEventRecord,
  stableHash,
};

