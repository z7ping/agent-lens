#!/usr/bin/env node
/**
 * importers/base.js - JSONL 历史导入器基类
 *
 * 职责：
 *  1. 递归扫描工具自己的 JSONL 数据目录（如 ~/.claude/projects、~/.codex/sessions）
 *  2. 按「文件路径 + 已处理行数 + mtime」水位线增量读取，避免每次全量重扫 / 重复导入
 *  3. 调用子类 parseLines() 把原始行解析为统一 timeline 记录
 *  4. 写入 a-beat.db（timeline + daily_stats + recent_errors），并按 timeline 重算 session 摘要
 */

const fs = require('fs');
const path = require('path');

const STATES_DIR = path.join(__dirname, '..', 'states');

const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.JSONL_IMPORT_INTERVAL_MS, 10) || 30 * 60 * 1000;

class JsonlImporter {
    /**
     * @param {Object} opts
     * @param {string} opts.source          来源标识（'claude-code' | 'codex'）
     * @param {string} opts.rootDir         递归扫描根目录
     * @param {string} opts.stateFile       水位线状态文件路径
     * @param {Function} opts.parseLines    解析函数 (lines[], ctx) => { records, meta }
     */
    constructor(opts) {
        if (!opts || !opts.source || !opts.rootDir || !opts.stateFile || typeof opts.parseLines !== 'function') {
            throw new Error('JsonlImporter: source/rootDir/stateFile/parseLines 必填');
        }
        this.source = opts.source;
        this.rootDir = opts.rootDir;
        this.stateFile = opts.stateFile;
        this.parseLines = opts.parseLines;
        this._timer = null;
    }

    // ─── 状态文件 ───────────────────────────────────────

    _readState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                if (state && typeof state === 'object') {
                    if (!state.files) state.files = {};
                    return state;
                }
            }
        } catch (_) {}
        return { files: {}, lastScan: null };
    }

    _writeState(state) {
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
        } catch (_) {}
    }

    // ─── 文件扫描 ───────────────────────────────────────

    _collectFiles(dir) {
        const out = [];
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                out.push(...this._collectFiles(full));
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                out.push(full);
            }
        }
        return out;
    }

    // ─── 单次轮询 ───────────────────────────────────────

    async pollOnce() {
        if (!fs.existsSync(this.rootDir)) return 0;
        const state = this._readState();
        const files = this._collectFiles(this.rootDir);
        const filesState = state.files || {};
        const newStates = {};
        const touchedSessions = new Set();
        let imported = 0;

        for (const filePath of files) {
            let stat;
            try { stat = fs.statSync(filePath); } catch { continue; }
            const mtime = stat.mtimeMs;
            const prev = filesState[filePath] || { lines: 0, mtime: 0, meta: null };

            if (prev.lines > 0 && prev.mtime === mtime) {
                // 文件未变化，跳过
                newStates[filePath] = prev;
                continue;
            }

            let all = [];
            try {
                all = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
            } catch { newStates[filePath] = prev; continue; }

            const totalLines = all.length;
            // 截断/重写时从头读，否则从上次行数续读（append-only）
            const start = totalLines < prev.lines ? 0 : prev.lines;
            const newLines = start === 0 ? all : all.slice(start);

            if (newLines.length > 0) {
                try {
                    const { records, meta } = this.parseLines(newLines, { filePath, meta: prev.meta || null }) || { records: [], meta: null };
                    this._ingest(records, touchedSessions);
                    imported += records.length;
                    newStates[filePath] = { lines: totalLines, mtime, meta: meta || prev.meta || null };
                } catch (e) {
                    // 单文件解析失败不阻塞整体，水位线停在已读位置
                    newStates[filePath] = { lines: start, mtime, meta: prev.meta || null };
                }
            } else {
                newStates[filePath] = { lines: totalLines, mtime, meta: prev.meta || null };
            }
        }

        // 清理已删除文件的记录
        const known = new Set(files);
        for (const key of Object.keys(filesState)) {
            if (!known.has(key)) delete filesState[key];
        }

        if (imported > 0 && touchedSessions.size > 0) {
            try { await this._recomputeSessions(touchedSessions); } catch (_) {}
        }

        state.files = newStates;
        state.lastScan = new Date().toISOString();
        this._writeState(state);
        return imported;
    }

    // ─── 写入 DB ────────────────────────────────────────

    _ingest(records, touchedSessions) {
        const abeatDb = require('../abeat-db');
        for (const r of records) {
            if (!r || !r.ts || !r.session_id) continue;
            touchedSessions.add(r.session_id);

            const info = abeatDb.insertTimeline({
                source: this.source,
                session_id: r.session_id,
                timestamp: r.ts,
                seq: null,
                role: r.role || 'tool',
                tool_name: r.tool_name || null,
                content: r.content || null,
                tool_input: r.tool_input ? (typeof r.tool_input === 'string' ? r.tool_input : JSON.stringify(r.tool_input)) : null,
                success: r.success == null ? null : (r.success ? 1 : 0),
                exit_code: r.exit_code ?? null,
                duration_ms: r.duration_ms ?? null,
                output_snippet: r.output_snippet || null,
                error_message: r.error_message || null,
                error_type: null,
                error_detail: null,
                project_key: r.project_key || null,
                parent_seq: null,
                tool_use_id: r.tool_use_id || null,
            });

            const isTool = r.role === 'tool_result' || r.role === 'tool_error';
            if (isTool && info.changes > 0) {
                const date = (r.ts || '').slice(0, 10);
                if (date) abeatDb.updateDailyStats(date, this.source, r.tool_name || 'unknown', 1, r.success ? 0 : 1, r.duration_ms || 0);
                if (!r.success && r.error_message) {
                    abeatDb.saveError(r.ts, r.session_id, this.source, r.tool_name || '', r.error_message);
                }
            }
        }
    }

    /**
     * 重算受影响的 session 摘要（以 timeline 为唯一口径，与前端概览一致）
     */
    async _recomputeSessions(sessionIds) {
        const abeatDb = require('../abeat-db');
        for (const sessionId of sessionIds) {
            try {
                const rows = abeatDb.queryTimeline({ session_id: sessionId, source: this.source, limit: 100000 });
                if (rows.length === 0) continue;

                let firstTs = null, lastTs = null;
                let toolCount = 0, errorCount = 0, totalDuration = 0;
                let projectKey = null;

                for (const row of rows) {
                    if (row.timestamp && (!firstTs || row.timestamp < firstTs)) firstTs = row.timestamp;
                    if (row.timestamp && (!lastTs || row.timestamp > lastTs)) lastTs = row.timestamp;
                    if (row.project_key) projectKey = row.project_key;
                    if (row.role === 'tool_result' || row.role === 'tool_error') {
                        toolCount++;
                        if (row.success === 0) errorCount++;
                        totalDuration += row.duration_ms || 0;
                    }
                }

                abeatDb.upsertSession({
                    session_id: sessionId,
                    project_key: projectKey || '',
                    source: this.source,
                    start_time: firstTs || '',
                    end_time: lastTs || '',
                    tool_count: toolCount,
                    error_count: errorCount,
                    total_duration_ms: totalDuration,
                });
            } catch (_) {}
        }
    }

    // ─── 生命周期 ───────────────────────────────────────

    startPolling(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
        if (this._timer) return;
        this.pollOnce();
        this._timer = setInterval(() => { try { this.pollOnce(); } catch (_) {} }, intervalMs);
    }

    stopPolling() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    /** 当前是否已配置历史数据目录（存在 jsonl） */
    hasHistory() {
        if (!fs.existsSync(this.rootDir)) return false;
        return this._collectFiles(this.rootDir).length > 0;
    }
}

module.exports = { JsonlImporter, DEFAULT_POLL_INTERVAL_MS };
