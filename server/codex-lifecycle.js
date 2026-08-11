const crypto = require('crypto');

const CODEX_LIFECYCLE_EVENT_TYPES = Object.freeze({
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt',
  PermissionRequest: 'permission_request',
  PreCompact: 'compact_start',
  PostCompact: 'compact_end',
  SubagentStart: 'agent_start',
  SubagentStop: 'agent_stop',
  Stop: 'turn_stop',
});

const TURN_SCOPED_EVENTS = new Set([
  'UserPromptSubmit',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function buildMissingReason(eventName, data) {
  const reasons = [];
  if (TURN_SCOPED_EVENTS.has(eventName) && !data.turn_id) {
    reasons.push('Hook 未提供 Turn 标识');
  }
  if ((eventName === 'SubagentStart' || eventName === 'SubagentStop') && !data.agent_id) {
    reasons.push('Hook 未提供子 Agent 标识');
  }
  if (eventName === 'SubagentStop' && !data.agent_transcript_path) {
    reasons.push('来源未提供子 Agent transcript');
  }
  if ((eventName === 'SubagentStop' || eventName === 'Stop') && data.last_assistant_message == null) {
    reasons.push('来源未提供最后一条助手消息');
  }
  return reasons.length > 0 ? reasons.join('；') : null;
}

function buildCodexLifecycleRecord(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const eventName = String(data.hook_event_name || '');
  const eventType = CODEX_LIFECYCLE_EVENT_TYPES[eventName];
  const sessionId = String(data.session_id || '');
  if (!eventType || !sessionId) return null;

  let content = null;
  if (eventName === 'UserPromptSubmit') content = data.prompt ?? null;
  if (eventName === 'SubagentStop' || eventName === 'Stop') {
    content = data.last_assistant_message ?? null;
  }

  const attributes = compactObject({
    hook_event_name: eventName,
    model: data.model || undefined,
    permission_mode: data.permission_mode || undefined,
    start_source: eventName === 'SessionStart' ? (data.source || undefined) : undefined,
    lifecycle_reason: eventName === 'SessionEnd' ? (data.reason || undefined) : undefined,
    compact_trigger: eventName === 'PreCompact' || eventName === 'PostCompact'
      ? (data.trigger || undefined)
      : undefined,
    agent_type: eventName === 'SubagentStart' || eventName === 'SubagentStop'
      ? (data.agent_type || undefined)
      : undefined,
    stop_hook_active: eventName === 'SubagentStop' || eventName === 'Stop'
      ? Boolean(data.stop_hook_active)
      : undefined,
    transcript_available: Boolean(data.transcript_path),
    agent_transcript_available: eventName === 'SubagentStop'
      ? Boolean(data.agent_transcript_path)
      : undefined,
  });

  const rawToolInput = eventName === 'PermissionRequest' ? (data.tool_input || {}) : null;
  const toolInput = rawToolInput && typeof options.summarizeToolInput === 'function'
    ? options.summarizeToolInput(data.tool_name || '', rawToolInput)
    : rawToolInput;
  const sourceEventId = String(
    data.source_event_id
      || data.hook_invocation_id
      || `hook:${eventName}:${crypto.randomUUID()}`,
  );

  return {
    source: 'codex',
    source_event_id: sourceEventId,
    session_id: sessionId,
    timestamp: data.timestamp || new Date().toISOString(),
    event_type: eventType,
    role: eventType,
    agent_id: data.agent_id || null,
    turn_id: data.turn_id || null,
    tool_name: eventName === 'PermissionRequest' ? (data.tool_name || null) : null,
    tool_input: toolInput,
    content,
    project_key: options.projectKey || null,
    parent_event_id: options.parentEventId || null,
    attributes_json: attributes,
    capture_method: 'runtime_hook',
    visibility: 'captured',
    confidence: 'confirmed',
    missing_reason: buildMissingReason(eventName, data),
  };
}

function neutralHookOutput(eventName) {
  return eventName === 'Stop' || eventName === 'SubagentStop' ? '{}' : '';
}

module.exports = {
  CODEX_LIFECYCLE_EVENT_TYPES,
  TURN_SCOPED_EVENTS,
  buildCodexLifecycleRecord,
  neutralHookOutput,
};
