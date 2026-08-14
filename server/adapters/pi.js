#!/usr/bin/env node
/**
 * Pi 适配器
 *
 * 原生 Session JSONL 是 Pi 的持久证据。适配器按字节偏移增量读取，使用
 * entry id / parentId / parentSession / toolCallId 保留树形身份与工具配对。
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { stableHash } = require('../event-model');
const { pi: { sessionsDir: PI_SESSIONS_DIR }, agentLens } = require('../paths');

const POLL_INTERVAL_MS = parseInt(process.env.PI_POLL_INTERVAL_MS, 10) || 30 * 1000;
const POLL_RECORD_LIMIT = parseInt(process.env.PI_POLL_RECORD_LIMIT, 10) || 10000;
const IMPORT_STATE_VERSION = 1;

function piEntryEventId(sessionId, nativeId) {
    return `evt_${stableHash(`pi|${sessionId}|entry|${nativeId}`).slice(0, 32)}`;
}

function piToolEventId(sessionId, callId, eventType) {
    return `evt_${stableHash(`pi|${sessionId}|tool|${callId}|${eventType}`).slice(0, 32)}`;
}

function piRuntimeEventId(sessionId, nativeId, eventType) {
    return `evt_${stableHash(`pi|${sessionId}|runtime|${nativeId}|${eventType}`).slice(0, 32)}`;
}

function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    return value ? String(value) : '';
}

function normalizeRuntimeEventType(value) {
    const raw = String(value || '').trim();
    const key = raw.replace(/[-\s]+/g, '_').toLowerCase();
    const aliases = {
        session: 'session_start',
        session_start: 'session_start',
        session_end: 'session_end',
        session_shutdown: 'session_end',
        input: 'user_prompt',
        user_input: 'user_prompt',
        user_prompt: 'user_prompt',
        context: 'context_snapshot',
        context_snapshot: 'context_snapshot',
        turn_start: 'turn_start',
        turn_end: 'turn_stop',
        turn_stop: 'turn_stop',
        agent_start: 'agent_start',
        agent_end: 'agent_end',
        tool_call: 'tool_use',
        tool_use: 'tool_use',
        tool_start: 'tool_use',
        tool_result: 'tool_result',
        tool_end: 'tool_result',
        tool_error: 'tool_error',
        compact_start: 'compact_start',
        compact_end: 'compact_end',
        compaction: 'compact_end',
        settled: 'settled',
    };
    return aliases[key] || key || 'runtime_event';
}

function runtimeRoleForEvent(eventType, success) {
    if (eventType === 'tool_result') return success === false ? 'tool_error' : 'tool_result';
    if (eventType === 'tool_error') return 'tool_error';
    if (eventType === 'user_prompt') return 'user';
    return eventType;
}

function readCompleteLines(filePath, offset = 0) {
    const stat = fs.statSync(filePath);
    const start = offset >= 0 && offset <= stat.size ? offset : 0;
    if (stat.size === start) return { lines: [], nextOffset: start, size: stat.size };

    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline < 0) return { lines: [], nextOffset: start, size: stat.size };
        const complete = buffer.subarray(0, lastNewline + 1).toString('utf8');
        return {
            lines: complete.split(/\r?\n/).filter(Boolean),
            nextOffset: start + lastNewline + 1,
            size: stat.size,
        };
    } finally {
        fs.closeSync(fd);
    }
}

class PiAdapter extends BaseAdapter {
    constructor(options = {}) {
        super();
        this.sessionsDir = options.sessionsDir || PI_SESSIONS_DIR;
        this.importStateFile = options.importStateFile || path.join(agentLens.stateDir, 'pi-import-state.json');
        this.db = options.db || null;
        this.registerProject = options.registerProject || ((...args) => this.updateProjectsFile(...args));
        this._pollTimer = null;
        this._parentSessionCache = new Map();
    }

    get name() { return 'pi'; }

    async pre(data) { /* Pi 实时扩展由独立被动入口接入。 */ }

    async post(data) { /* Pi 实时扩展由独立被动入口接入。 */ }

    _listSessionFiles() {
        if (!fs.existsSync(this.sessionsDir)) return [];
        const files = [];
        for (const projectDir of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
            if (!projectDir.isDirectory()) continue;
            const dir = path.join(this.sessionsDir, projectDir.name);
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name));
            }
        }
        return files.sort();
    }

    _readImportState() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.importStateFile, 'utf8'));
            if (parsed?.version === IMPORT_STATE_VERSION && parsed.files && typeof parsed.files === 'object') return parsed;
        } catch (_) {}
        return { version: IMPORT_STATE_VERSION, files: {} };
    }

    _writeImportState(state) {
        fs.mkdirSync(path.dirname(this.importStateFile), { recursive: true });
        const temp = `${this.importStateFile}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 2));
        fs.renameSync(temp, this.importStateFile);
    }

    _fileStateKey(filePath) {
        return stableHash(path.resolve(filePath).toLowerCase()).slice(0, 32);
    }

    _readSessionHeader(filePath) {
        try {
            const fd = fs.openSync(filePath, 'r');
            try {
                const size = Math.min(fs.fstatSync(fd).size, 64 * 1024);
                const buffer = Buffer.alloc(size);
                fs.readSync(fd, buffer, 0, size, 0);
                const firstLine = buffer.toString('utf8').split(/\r?\n/, 1)[0];
                const header = JSON.parse(firstLine);
                return header?.type === 'session' ? header : null;
            } finally {
                fs.closeSync(fd);
            }
        } catch (_) {
            return null;
        }
    }

    _resolveParentSessionId(parentSession, currentFile) {
        if (!parentSession) return null;
        const resolved = path.isAbsolute(parentSession)
            ? parentSession
            : path.resolve(path.dirname(currentFile), parentSession);
        if (this._parentSessionCache.has(resolved)) return this._parentSessionCache.get(resolved);
        const id = this._readSessionHeader(resolved)?.id || null;
        this._parentSessionCache.set(resolved, id);
        return id;
    }

    _sessionMeta(header, filePath) {
        if (!header) return null;
        return {
            id: String(header.id || ''),
            cwd: String(header.cwd || process.cwd()),
            version: header.version ?? null,
            timestamp: normalizeTimestamp(header.timestamp),
            parent_session_id: this._resolveParentSessionId(header.parentSession, filePath),
            parent_session_available: Boolean(header.parentSession),
        };
    }

    _baseRecord(meta, entry, sourceSequence, overrides = {}) {
        const cwd = meta.cwd || process.cwd();
        const projectKey = this.getProjectKey(cwd);
        const parentNativeId = entry?.parentId || null;
        return {
            ts: normalizeTimestamp(entry?.timestamp || entry?.message?.timestamp || meta.timestamp),
            timestamp: normalizeTimestamp(entry?.timestamp || entry?.message?.timestamp || meta.timestamp),
            session_id: meta.id,
            project_key: projectKey,
            project_name: this.getProjectName(cwd),
            cwd,
            source: this.name,
            source_sequence: sourceSequence,
            parent_event_id: parentNativeId ? piEntryEventId(meta.id, parentNativeId) : null,
            capture_method: 'native_log',
            visibility: 'captured',
            confidence: 'confirmed',
            ...overrides,
        };
    }

    _extractText(content) {
        const blocks = Array.isArray(content) ? content : [content];
        return blocks.map(block => {
            if (!block) return '';
            if (typeof block === 'string') return block;
            return block.type === 'text' ? (block.text || '') : '';
        }).filter(Boolean).join('\n\n');
    }

    _thinkingMetadata(content) {
        const blocks = Array.isArray(content) ? content : [];
        const thinking = blocks.filter(block => block?.type === 'thinking');
        return thinking.length ? { thinking_present: true, thinking_blocks: thinking.length } : {};
    }

    _summarizeInput(toolName, input) {
        if (!input || typeof input !== 'object') return {};
        const summary = {};
        if (toolName === 'bash') {
            const cmd = String(input.command || '');
            summary.command = cmd.length > 120 ? `${cmd.substring(0, 120)}…` : cmd;
        } else if (['read', 'write', 'edit'].includes(toolName)) {
            summary.file_path = input.path || '';
        } else {
            summary.keys = Object.keys(input).slice(0, 8);
        }
        return summary;
    }

    _turnIdForEntry(entry, contextByEntry) {
        if (entry?.type === 'message' && entry.message?.role === 'user') return entry.id ? `pi-turn:${entry.id}` : null;
        return entry?.parentId ? (contextByEntry[entry.parentId]?.turn_id || null) : null;
    }

    normalizeRuntimeEvent(data = {}) {
        const eventType = normalizeRuntimeEventType(data.event_type || data.runtime_event_type || data.type);
        const sessionId = String(data.session_id || data.sessionId || data.session?.id || '');
        if (!sessionId) return [];
        const cwd = String(data.cwd || data.project_cwd || data.session?.cwd || process.cwd());
        const projectKey = data.project_key || this.getProjectKey(cwd);
        const nativeId = String(data.source_event_id || data.native_id || data.id || data.event_id || `${eventType}:${data.timestamp || Date.now()}`);
        const timestamp = normalizeTimestamp(data.timestamp || data.ts || Date.now());
        const callId = data.tool_call_id || data.toolCallId || data.call_id || data.tool_use_id || '';
        const toolName = data.tool_name || data.toolName || data.name || '';
        const success = eventType === 'tool_error' ? false : data.success;
        const attributes = {
            ...(data.attributes && typeof data.attributes === 'object' ? data.attributes : {}),
            runtime_event_type: eventType,
            native_event_type: data.type || data.event_type || '',
            extension_version: data.extension_version || data.version || '',
            history_entry_id: data.history_entry_id || data.entry_id || '',
        };
        if (callId) {
            attributes.reconciliation_key = `pi:${sessionId}:tool:${callId}`;
            attributes.reconciliation_evidence = 'runtime_hook';
        }
        const common = {
            event_id: callId && ['tool_use', 'tool_result', 'tool_error'].includes(eventType)
                ? piToolEventId(sessionId, callId, eventType === 'tool_error' ? 'tool_result' : eventType)
                : piRuntimeEventId(sessionId, nativeId, eventType),
            source_event_id: nativeId,
            session_id: sessionId,
            source: this.name,
            timestamp,
            ts: timestamp,
            cwd,
            project_key: projectKey,
            project_name: this.getProjectName(cwd),
            source_sequence: data.seq ?? data.source_sequence ?? null,
            event_type: eventType === 'tool_error' ? 'tool_error' : eventType,
            role: runtimeRoleForEvent(eventType, success),
            call_id: callId || null,
            tool_use_id: callId || null,
            tool_name: toolName || null,
            content: data.content || data.text || data.summary || null,
            tool_input: data.tool_input || data.input_summary || data.input || null,
            output_snippet: data.output_snippet || data.output || data.result || null,
            success: success == null ? null : Boolean(success),
            duration_ms: data.duration_ms ?? null,
            parent_event_id: data.parent_event_id || null,
            turn_id: data.turn_id || data.turnId || (data.turn_id === 0 ? '0' : null),
            agent_id: data.agent_id || data.agentId || null,
            capture_method: 'runtime_hook',
            visibility: 'captured',
            confidence: callId || !['tool_use', 'tool_result', 'tool_error'].includes(eventType) ? 'confirmed' : 'partial',
            missing_reason: callId || !['tool_use', 'tool_result', 'tool_error'].includes(eventType)
                ? null
                : 'Pi 运行时事件未提供稳定工具调用标识',
            attributes_json: attributes,
        };
        if (eventType === 'tool_result' || eventType === 'tool_error') {
            common.parent_event_id = data.parent_event_id || (callId ? piToolEventId(sessionId, callId, 'tool_use') : null);
            common.success = eventType === 'tool_error' ? false : data.success !== false;
        }
        return [common];
    }

    ingestRuntimeEvent(data = {}, db = null) {
        const agentLensDb = db || this.db || require('../agent-lens-db');
        const records = this.normalizeRuntimeEvent(data);
        const inserted = [];
        for (const record of records) {
            const info = agentLensDb.insertTimeline({
                ...record,
                tool_input: record.tool_input || null,
                error_message: record.success === false ? (record.output_snippet || record.error_message || null) : null,
            });
            inserted.push({ record, info });
            if (info.changes > 0 && (record.event_type === 'tool_result' || record.event_type === 'tool_error')) {
                const date = (record.timestamp || '').slice(0, 10);
                agentLensDb.updateDailyStats(date, 'pi', record.tool_name || 'unknown', 1, record.success ? 0 : 1, record.duration_ms || 0);
            }
        }
        const first = records[0];
        if (first?.session_id && typeof agentLensDb.recomputeSession === 'function') {
            agentLensDb.recomputeSession('pi', first.session_id, first.project_key || '');
        }
        return { ok: true, inserted: inserted.reduce((sum, item) => sum + (item.info?.changes || 0), 0), records };
    }

    _parseLines(lines, parserState, filePath) {
        const records = [];
        const state = parserState || {};
        state.line_number = Number.isInteger(state.line_number) ? state.line_number : 0;
        state.context_by_entry = state.context_by_entry || {};
        state.pending_calls = state.pending_calls || {};
        let meta = state.session_meta || null;

        for (const line of lines) {
            const lineNumber = state.line_number++;
            let entry;
            try { entry = JSON.parse(line); } catch (_) { continue; }

            if (entry.type === 'session') {
                meta = this._sessionMeta(entry, filePath);
                state.session_meta = meta;
                if (!meta?.id) continue;
                this.registerProject(this.getProjectKey(meta.cwd), meta.cwd, this.getProjectName(meta.cwd));
                const attributes = {
                    session_version: meta.version,
                    parent_session_id: meta.parent_session_id,
                    parent_session_available: meta.parent_session_available,
                };
                records.push(this._baseRecord(meta, entry, lineNumber * 1000, {
                    event_id: piEntryEventId(meta.id, `session:${meta.id}`),
                    source_event_id: `session:${meta.id}`,
                    event_type: 'session_start',
                    role: 'session_start',
                    parent_event_id: null,
                    attributes_json: attributes,
                }));
                continue;
            }
            if (!meta?.id || !entry?.id) continue;

            const sequence = lineNumber * 1000;
            const turnId = this._turnIdForEntry(entry, state.context_by_entry);
            const entryEventId = piEntryEventId(meta.id, entry.id);
            const base = this._baseRecord(meta, entry, sequence, {
                event_id: entryEventId,
                source_event_id: entry.id,
                turn_id: turnId,
            });
            const attributes = { native_entry_type: entry.type, native_parent_id: entry.parentId || null };

            if (entry.type === 'message' && entry.message) {
                const role = entry.message.role;
                const content = entry.message.content;
                if (role === 'user') {
                    records.push({ ...base, event_type: 'user_prompt', role: 'user', content: this._extractText(content), attributes_json: attributes });
                } else if (role === 'assistant') {
                    const toolCalls = (Array.isArray(content) ? content : []).filter(block => block?.type === 'toolCall');
                    records.push({
                        ...base,
                        event_type: 'assistant',
                        role: 'assistant',
                        content: this._extractText(content) || null,
                        attributes_json: {
                            ...attributes,
                            ...this._thinkingMetadata(content),
                            provider: entry.message.provider || null,
                            model: entry.message.model || null,
                            stop_reason: entry.message.stopReason || null,
                        },
                    });
                    toolCalls.forEach((block, index) => {
                        const callId = String(block.id || '');
                        if (!callId) return;
                        const toolName = block.name || 'unknown';
                        const inputSummary = this._summarizeInput(toolName, block.arguments || {});
                        const useEventId = piToolEventId(meta.id, callId, 'tool_use');
                        records.push({
                            ...base,
                            event_id: useEventId,
                            source_event_id: `${entry.id}:tool:${callId}`,
                            source_sequence: sequence + index + 1,
                            event_type: 'tool_use',
                            role: 'tool_use',
                            call_id: callId,
                            tool_name: toolName,
                            input_summary: inputSummary,
                            tool_input: inputSummary,
                            parent_event_id: entryEventId,
                            content: null,
                            success: null,
                            attributes_json: {
                                ...attributes,
                                reconciliation_key: `pi:${meta.id}:tool:${callId}`,
                                reconciliation_evidence: 'native_log',
                            },
                        });
                        state.pending_calls[callId] = {
                            started_at: base.timestamp,
                            tool_name: toolName,
                            use_event_id: useEventId,
                            turn_id: turnId,
                        };
                    });
                } else if (role === 'tool' || role === 'toolResult') {
                    const callId = String(entry.message.toolCallId || '');
                    const pending = callId ? state.pending_calls[callId] : null;
                    const startedAt = pending?.started_at || '';
                    const endedAt = base.timestamp;
                    const elapsed = startedAt && endedAt ? new Date(endedAt) - new Date(startedAt) : NaN;
                    const isError = entry.message.isError === true;
                    records.push({
                        ...base,
                        event_id: entryEventId,
                        event_type: isError ? 'tool_error' : 'tool_result',
                        role: isError ? 'tool_error' : 'tool_result',
                        call_id: callId || null,
                        tool_name: entry.message.toolName || pending?.tool_name || 'unknown',
                        input_summary: pending?.input_summary || null,
                        tool_input: pending?.input_summary || null,
                        output_snippet: this._extractText(content) || null,
                        success: !isError,
                        duration_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
                        parent_event_id: pending?.use_event_id || base.parent_event_id,
                        turn_id: pending?.turn_id || turnId,
                        confidence: pending ? 'confirmed' : 'partial',
                        missing_reason: pending ? null : '当前增量范围未找到对应 Tool Use；仅保留来源 toolCallId',
                        attributes_json: attributes,
                    });
                    if (callId) {
                        records[records.length - 1].attributes_json = {
                            ...records[records.length - 1].attributes_json,
                            reconciliation_key: `pi:${meta.id}:tool:${callId}`,
                            reconciliation_evidence: 'native_log',
                        };
                    }
                    if (callId) delete state.pending_calls[callId];
                } else {
                    const text = this._extractText(content);
                    if (text) records.push({ ...base, event_type: role || 'message', role: role || 'message', content: text, attributes_json: attributes });
                }
            } else if (entry.type === 'model_change') {
                records.push({ ...base, event_type: 'model_change', role: 'model_change', attributes_json: { ...attributes, provider: entry.provider || null, model: entry.modelId || null } });
            } else if (entry.type === 'thinking_level_change') {
                records.push({ ...base, event_type: 'thinking_level_change', role: 'thinking_level_change', attributes_json: { ...attributes, thinking_level: entry.thinkingLevel || null } });
            } else if (entry.type === 'compaction') {
                records.push({
                    ...base,
                    event_type: 'compact_end',
                    role: 'compact_end',
                    content: entry.summary || null,
                    attributes_json: {
                        ...attributes,
                        tokens_before: entry.tokensBefore ?? null,
                        first_kept_entry_id: entry.firstKeptEntryId || null,
                        retained_tail_count: Array.isArray(entry.retainedTail) ? entry.retainedTail.length : 0,
                        from_extension: entry.fromHook === true,
                    },
                });
            } else if (entry.type === 'branch_summary') {
                records.push({
                    ...base,
                    event_type: 'branch_summary',
                    role: 'branch_summary',
                    content: entry.summary || null,
                    attributes_json: { ...attributes, branch_from_entry_id: entry.fromId || null, from_extension: entry.fromHook === true },
                });
            } else if (entry.type === 'session_info') {
                records.push({ ...base, event_type: 'session_info', role: 'session_info', attributes_json: { ...attributes, session_name: entry.name || null } });
            }

            state.context_by_entry[entry.id] = { turn_id: turnId, event_id: entryEventId };
        }
        state.session_meta = meta;
        return records;
    }

    async getRecords(filter = {}) {
        const limit = Math.min(parseInt(filter.limit, 10) || 1000, POLL_RECORD_LIMIT);
        const records = [];
        for (const filePath of this._listSessionFiles()) {
            try {
                const { lines } = readCompleteLines(filePath, 0);
                const parsed = this._parseLines(lines, {}, filePath);
                for (const record of parsed) {
                    if (filter.session_id && record.session_id !== filter.session_id) continue;
                    if (filter.project_key && record.project_key !== filter.project_key) continue;
                    records.push(record);
                }
            } catch (_) {}
        }
        records.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '') || (b.source_sequence || 0) - (a.source_sequence || 0));
        return records.slice(0, limit);
    }

    startPolling(intervalMs = POLL_INTERVAL_MS) {
        if (this._pollTimer) return;
        this._pollOnce();
        this._pollTimer = setInterval(() => this._pollOnce(), intervalMs);
    }

    async _pollOnce() {
        const importState = this._readImportState();
        const touchedSessions = new Map();
        let changed = false;

        for (const filePath of this._listSessionFiles()) {
            const key = this._fileStateKey(filePath);
            const stat = fs.statSync(filePath);
            let fileState = importState.files[key] || { offset: 0, line_number: 0, context_by_entry: {}, pending_calls: {} };
            if (stat.size < (fileState.offset || 0)) fileState = { offset: 0, line_number: 0, context_by_entry: {}, pending_calls: {} };
            const chunk = readCompleteLines(filePath, fileState.offset || 0);
            if (!chunk.lines.length) continue;
            const records = this._parseLines(chunk.lines, fileState, filePath);
            for (const record of records) {
                this._aggregateToDb(record);
                if (record.session_id) touchedSessions.set(record.session_id, record.project_key || '');
            }
            fileState.offset = chunk.nextOffset;
            fileState.size = chunk.size;
            fileState.updated_at = new Date().toISOString();
            importState.files[key] = fileState;
            changed = true;
        }

        if (changed) this._writeImportState(importState);
        if (touchedSessions.size) {
            const agentLensDb = this.db || require('../agent-lens-db');
            for (const [sessionId, projectKey] of touchedSessions) agentLensDb.recomputeSession('pi', sessionId, projectKey);
        }
    }

    _aggregateToDb(record) {
        const agentLensDb = this.db || require('../agent-lens-db');
        const info = agentLensDb.insertTimeline({
            ...record,
            timestamp: record.timestamp || record.ts || '',
            tool_input: record.tool_input || record.input_summary || null,
            error_message: record.success === false ? (record.output_snippet || null) : null,
        });
        if (info.changes > 0 && (record.event_type === 'tool_result' || record.event_type === 'tool_error')) {
            const date = (record.timestamp || record.ts || '').slice(0, 10);
            agentLensDb.updateDailyStats(date, 'pi', record.tool_name, 1, record.success ? 0 : 1, record.duration_ms || 0);
        }
        return info;
    }

    stopPolling() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    }
}

module.exports = PiAdapter;
module.exports.readCompleteLines = readCompleteLines;
