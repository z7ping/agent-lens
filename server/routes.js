/**
 * API 路由处理
 * 从 server.js 拆分，职责：处理 /api/* 请求
 */

const fs = require('fs');
const path = require('path');
const { getAdapter, getAllAdapters } = require('./adapters');
const { getDb, queryStats, queryTimeline } = require('./abeat-db');
const { queryToolMap } = require('./tool-map');
const { queryOverview, scheduleOverviewRefresh } = require('./overview');
const { detectSourceStatus } = require('./sources-status');
const { getAppInfo } = require('./app-info');

const ROOT = path.join(__dirname, '..');
const PROJECT_REGISTRY_FILES = [
    path.join(ROOT, 'projects.json'),
    path.join(__dirname, 'projects.json'),
];

function sendJson(res, data, statusCode = 200) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}

function loadProjects() {
    const projects = {};
    for (const file of PROJECT_REGISTRY_FILES) {
        try {
            if (!fs.existsSync(file)) continue;
            const content = fs.readFileSync(file, 'utf-8').trim();
            if (!content) continue;
            Object.assign(projects, JSON.parse(content));
        } catch (_) {}
    }
    return projects;
}

function enrichProjectFields(row, projects) {
    const proj = projects[row.project_key] || null;
    return {
        ...row,
        project_name: row.project_name || proj?.name || row.project_key || '',
        project_cwd: row.project_cwd || row.cwd || proj?.cwd || '',
    };
}

async function handleApiStats(req, res, params) {
    try {
        const source = params.get('source');
        const since = params.get('since');

        if (source === 'hermes') {
            const hermesAdapter = getAdapter('hermes');
            if (hermesAdapter) {
                const stats = await hermesAdapter.getStats({ since });
                sendJson(res, stats);
                return;
            }
        }

        const db = getDb();
        if (!db) {
            sendJson(res, { error: 'SQLite 数据库不可用' }, 503);
            return;
        }

        const result = queryStats({ source, since });
        sendJson(res, result);
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

async function handleApiTools(req, res, params) {
    try {
        const allAdapters = getAllAdapters();
        const toolMap = new Map();

        for (const [name, adapter] of allAdapters) {
            if (adapter.getTools) {
                const tools = await adapter.getTools();
                for (const t of tools) {
                    const key = t.tool_name;
                    if (toolMap.has(key)) {
                        const existing = toolMap.get(key);
                        existing.count += t.count || 0;
                        existing.errors += t.errors || 0;
                    } else {
                        toolMap.set(key, { tool_name: key, count: t.count || 0, errors: t.errors || 0 });
                    }
                }
            }
        }

        const database = getDb();
        if (database) {
            const dbTools = database.prepare(`
                SELECT tool_name, SUM(call_count) as count, SUM(error_count) as errors
                FROM daily_stats
                GROUP BY tool_name
            `).all();
            for (const t of dbTools) {
                const key = t.tool_name;
                if (toolMap.has(key)) {
                    const existing = toolMap.get(key);
                    existing.count += t.count || 0;
                    existing.errors += t.errors || 0;
                } else {
                    toolMap.set(key, { tool_name: key, count: t.count || 0, errors: t.errors || 0 });
                }
            }
        }

        const items = Array.from(toolMap.values()).sort((a, b) => b.count - a.count);
        sendJson(res, { items });
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

async function handleApiSessions(req, res, params) {
    try {
        const source = params.get('source');
        const project = params.get('project');
        const limit = Math.min(parseInt(params.get('limit') || '50', 10), 200);

        let allSessions = [];

        const adapters = source ? { [source]: getAdapter(source) } : Object.fromEntries(getAllAdapters());
        for (const [name, adapter] of Object.entries(adapters)) {
            if (!adapter || !adapter.getSessions) continue;
            const sessions = await adapter.getSessions({ project_key: project, limit });
            allSessions.push(...sessions);
        }

        const database = getDb();
        if (database) {
            let whereClause = 'WHERE 1=1';
            const queryParams = [];
            if (source) { whereClause += ' AND source = ?'; queryParams.push(source); }
            if (project) { whereClause += ' AND project_key = ?'; queryParams.push(project); }

            const dbSessions = database.prepare(`
                SELECT * FROM sessions ${whereClause}
                ORDER BY start_time DESC LIMIT ?
            `).all(...queryParams, limit * 2);
            allSessions.push(...dbSessions);
        }

        const seen = new Set();
        const unique = allSessions.filter(s => {
            if (seen.has(s.session_id)) return false;
            seen.add(s.session_id);
            return true;
        });
        unique.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));

        const projects = loadProjects();
        for (const s of unique) {
            Object.assign(s, enrichProjectFields(s, projects));
        }

        sendJson(res, { items: unique.slice(0, limit) });
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

async function handleApiTimeline(req, res, params) {
    const project = params.get('project');
    const session = params.get('session');
    const source = params.get('source') || null;
    const limit = Math.min(parseInt(params.get('limit') || '1000', 10), 10000);

    try {
        const items = await loadTimelineItems({ project, session, source, limit });

        const projects = loadProjects();

        // 统一字段名：timeline 表用 timestamp，前端可能期望 ts
        const formatted = items.map(row => ({
            ...enrichProjectFields(row, projects),
            ts: row.timestamp,
        }));

        sendJson(res, { items: formatted });
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

let skillsCache = null;
let skillsCacheTime = 0;
const SKILLS_CACHE_TTL = 30000;

function handleApiSkills(req, res, params) {
    if (skillsCache && (Date.now() - skillsCacheTime) < SKILLS_CACHE_TTL) {
        sendJson(res, skillsCache);
        return;
    }
    try {
        const claudeProjectsDir = path.join(require('os').homedir(), '.claude', 'projects');
        const sessions = [];
        const skillsSummary = {};

        if (!fs.existsSync(claudeProjectsDir)) {
            sendJson(res, { sessions: [], skillsSummary: {}, totalSessions: 0, totalUniqueSkills: 0 });
            return;
        }

        const jsonlFiles = [];
        const scanDir = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scanDir(fullPath);
                    } else if (entry.name.endsWith('.jsonl')) {
                        jsonlFiles.push(fullPath);
                    }
                }
            } catch (e) {}
        };
        scanDir(claudeProjectsDir);

        const processedSessions = new Set();
        for (const filePath of jsonlFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        const sessionId = entry.sessionId;

                        if (entry.type === 'assistant' && entry.message?.content) {
                            const contentArr = Array.isArray(entry.message.content) ? entry.message.content : [];
                            for (const item of contentArr) {
                                if (item.type === 'tool_use' && item.name === 'Skill' && item.input?.skill) {
                                    const skillName = item.input.skill;
                                    if (!skillsSummary[skillName]) {
                                        skillsSummary[skillName] = { count: 0, sessions: [] };
                                    }
                                    skillsSummary[skillName].count++;
                                    if (sessionId && !skillsSummary[skillName].sessions.includes(sessionId)) {
                                        skillsSummary[skillName].sessions.push(sessionId);
                                    }
                                }
                            }
                        }

                        if (entry.type === 'attachment' &&
                            entry.attachment &&
                            entry.attachment.type === 'skill_listing' &&
                            entry.sessionId) {
                            if (!processedSessions.has(entry.sessionId)) {
                                processedSessions.add(entry.sessionId);
                                sessions.push({
                                    sessionId: entry.sessionId,
                                    cwd: entry.cwd || '',
                                    timestamp: entry.timestamp || '',
                                    skillCount: entry.attachment.skillCount || entry.attachment.names?.length || 0,
                                    skills: entry.attachment.names || []
                                });
                            }
                        }
                    } catch (parseErr) {}
                }
            } catch (readErr) {}
        }

        sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const result = {
            sessions,
            skillsSummary,
            totalSessions: sessions.length,
            totalUniqueSkills: Object.keys(skillsSummary).length
        };
        skillsCache = result;
        skillsCacheTime = Date.now();
        sendJson(res, result);
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

// ─── 跨工具对比 API ───────────────────────────────────────────

function handleApiCompare(req, res) {
    try {
        const db = getDb();

        // 同类工具耗时对比
        const durationComparison = db.prepare(`
            SELECT tool_name, source,
                   ROUND(AVG(duration_ms), 0) as avg_ms,
                   COUNT(*) as calls
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND duration_ms IS NOT NULL
            GROUP BY tool_name, source
            ORDER BY tool_name, avg_ms DESC
        `).all();

        // 成功率对比
        const successRates = db.prepare(`
            SELECT tool_name, source,
                   COUNT(*) as total,
                   ROUND(100.0 * SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) as success_rate
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error')
            GROUP BY tool_name, source
            HAVING total >= 5
            ORDER BY success_rate DESC
        `).all();

        sendJson(res, { durationComparison, successRates });
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

// ─── 报错分析 API ─────────────────────────────────────────────

function handleApiErrors(req, res, params) {
    try {
        const db = getDb();
        const limit = Math.min(parseInt(params.get('limit') || '50', 10), 200);

        // 报错类型分布
        const errorTypeDistribution = db.prepare(`
            SELECT error_type, COUNT(*) as count
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND success = 0
            GROUP BY error_type
            ORDER BY count DESC
        `).all();

        // 哪个工具最容易报错
        const errorByTool = db.prepare(`
            SELECT tool_name, error_type, COUNT(*) as count
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND success = 0
            GROUP BY tool_name, error_type
            ORDER BY count DESC
        `).all();

        // 最近报错
        const recentErrors = db.prepare(`
            SELECT timestamp, source, tool_name, error_type, error_detail
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND success = 0
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);

        sendJson(res, { errorTypeDistribution, errorByTool, recentErrors });
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

const SOURCE_LABELS = {
    codex: 'Codex',
    'claude-code': 'Claude Code CLI',
    hermes: 'Hermes',
    opencode: 'OpenCode',
    cursor: 'Cursor',
    pi: 'Pi',
    openclaw: 'OpenClaw',
};

function sourceLabel(source) {
    return SOURCE_LABELS[source] || source || '未知来源';
}

function buildProjectIndex(rows = [], projects = {}, options = {}) {
    const sourceFilter = options.source || '';
    const byProject = new Map();
    for (const row of rows) {
        const source = row.source || '';
        const projectKey = row.project_key || '';
        if (!projectKey || !source) continue;
        if (sourceFilter && source !== sourceFilter) continue;
        const registry = projects[projectKey] || {};
        const project = byProject.get(projectKey) || {
            project_key: projectKey,
            name: registry.name || projectKey,
            cwd: registry.cwd || '',
            last_seen: '',
            session_count: 0,
            tool_count: 0,
            sources: [],
        };
        const sessionCount = Number(row.session_count || 0);
        const toolCount = Number(row.tool_count || 0);
        const lastSeen = row.last_seen || '';
        project.session_count += Number.isFinite(sessionCount) ? sessionCount : 0;
        project.tool_count += Number.isFinite(toolCount) ? toolCount : 0;
        if (!project.last_seen || lastSeen > project.last_seen) project.last_seen = lastSeen;
        project.sources.push({
            source,
            label: sourceLabel(source),
            session_count: sessionCount,
            tool_count: toolCount,
            last_seen: lastSeen,
        });
        byProject.set(projectKey, project);
    }
    const items = Array.from(byProject.values()).map(project => {
        project.sources.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || '') || a.label.localeCompare(b.label));
        project.source_label = project.sources.map(item => item.label).join(' · ');
        return project;
    }).sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || '') || a.name.localeCompare(b.name));
    return { items };
}

function queryProjectRows(db) {
    if (!db) return [];
    return db.prepare(`
        SELECT project_key,
               source,
               COUNT(*) as session_count,
               SUM(COALESCE(tool_count, 0)) as tool_count,
               MAX(COALESCE(end_time, start_time, '')) as last_seen
        FROM sessions
        WHERE project_key IS NOT NULL AND project_key != '' AND source IS NOT NULL AND source != ''
        GROUP BY project_key, source
    `).all();
}

function handleApiProjects(req, res, params) {
    try {
        const db = getDb();
        const projects = loadProjects();
        const rows = queryProjectRows(db);
        const result = buildProjectIndex(rows, projects, {
            source: params.get('source') || '',
        });
        sendJson(res, result);
    } catch (e) {
        sendJson(res, { error: e.message, items: [] }, 500);
    }
}

function handleApiSourcesStatus(req, res, params) {
    try {
        sendJson(res, detectSourceStatus());
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

function handleApiToolMap(req, res, params) {
    try {
        const db = getDb();
        if (!db) {
            sendJson(res, { error: 'SQLite 数据库不可用', summary: { total_tools: 0, high_value_tools: 0, high_risk_tools: 0, workflow_candidates: 0 }, items: [], workflow_patterns: [] }, 503);
            return;
        }
        const result = queryToolMap(db, {
            project: params.get('project') || '',
            source: params.get('source') || '',
            range: params.get('range') || 'week',
        });
        sendJson(res, result);
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

async function loadTimelineItems(options = {}) {
    const {
        project = '',
        session = '',
        source = '',
        limit = 1000,
        queryTimelineFn = queryTimeline,
        getAdapterFn = getAdapter,
    } = options;

    const rows = queryTimelineFn({
        session_id: session,
        source: source || undefined,
        project_key: project,
        limit,
    });
    if (rows.length > 0 || !source) return rows;

    const adapter = getAdapterFn(source);
    if (!adapter || typeof adapter.getRecords !== 'function') return rows;

    try {
        const adapterRows = await adapter.getRecords({
            session_id: session,
            source,
            project_key: project,
            limit,
        });
        return adapterRows.map(row => ({
            ...row,
            role: row.role || (row.tool_name ? (row.success === false || row.success === 0 ? 'tool_error' : 'tool_result') : ''),
        }));
    } catch (_) {
        return rows;
    }
}

function handleApiOverview(req, res, params) {
    try {
        const db = getDb();
        const result = queryOverview(db, {
            priorityThreshold: parseInt(params.get('priorityThreshold') || '5', 10),
        });
        sendJson(res, result);
        scheduleOverviewRefresh(db);
    } catch (e) {
        sendJson(res, { error: e.message, tools: [], priority_assets: [], capability_matrix: [] }, 500);
    }
}

function handleApiAppInfo(req, res) {
    try {
        sendJson(res, getAppInfo());
    } catch (e) {
        sendJson(res, { error: e.message }, 500);
    }
}

module.exports = { handleApiStats, handleApiTools, handleApiSessions, handleApiTimeline, handleApiSkills, handleApiCompare, handleApiErrors, handleApiToolMap, handleApiSourcesStatus, handleApiOverview, handleApiAppInfo, handleApiProjects, buildProjectIndex, loadTimelineItems };
