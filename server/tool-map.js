/**
 * Tool stack map scoring and aggregation.
 *
 * The scoring model is intentionally transparent: each score component is
 * returned with short Chinese explanations so the UI can show why a tool is
 * considered valuable or risky.
 */

const TOOL_ROLE_SQL = "role IN ('tool_result', 'tool_error')";

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function classifyToolType(toolName = '') {
    const name = String(toolName).toLowerCase();
    if (!name) return 'tool';
    if (name === 'skill' || name.includes('skill')) return 'skill';
    if (name.startsWith('mcp') || name.includes('mcp__')) return 'mcp';
    if (['bash', 'terminal', 'shell', 'execute'].some(k => name.includes(k))) return 'cli';
    if (['read', 'write', 'edit', 'patch', 'grep', 'glob', 'file'].some(k => name.includes(k))) return 'file';
    if (['agent', 'delegate', 'subagent', 'task'].some(k => name.includes(k))) return 'agent';
    return 'tool';
}

function recommendationFor(valueScore, errorRate, workflowScore) {
    if (errorRate >= 0.3) return '优化';
    if (valueScore >= 70) return '保留';
    if (workflowScore >= 20 && valueScore >= 50) return '沉淀';
    if (valueScore >= 35) return '观察';
    return '待观察';
}

function scoreTool(tool, context = {}) {
    const callCount = tool.call_count || 0;
    const sessionCount = tool.session_count || 0;
    const successCount = tool.success_count || 0;
    const errorCount = tool.error_count || 0;
    const total = Math.max(callCount, successCount + errorCount, 1);
    const errorRate = errorCount / total;
    const successRate = successCount / total;
    const maxCalls = Math.max(context.maxCalls || callCount || 1, 1);
    const maxSessions = Math.max(context.maxSessions || sessionCount || 1, 1);
    const maxPairCount = Math.max(context.maxPairCount || tool.common_pair_count || 1, 1);

    const frequencyScore = Math.round(
        clamp((callCount / maxCalls) * 25, 0, 25)
        + clamp((sessionCount / maxSessions) * 15, 0, 15)
    );

    const workflowScore = Math.round(
        clamp(((tool.successful_session_count || 0) / Math.max(sessionCount, 1)) * 15, 0, 15)
        + clamp(((tool.common_pair_count || 0) / maxPairCount) * 20, 0, 20)
    );

    const timeSavingScore = Math.round(
        clamp(successRate * 12, 0, 12)
        + clamp(((tool.terminal_success_count || 0) / Math.max(sessionCount, 1)) * 8, 0, 8)
        + clamp((callCount / maxCalls) * 5, 0, 5)
    );

    const riskLabels = Array.from(new Set((tool.risk_labels || []).filter(Boolean)));
    let riskPenalty = 0;
    if (errorRate > 0.3) riskPenalty += 20;
    else if (errorRate >= 0.1) riskPenalty += 10;
    if (riskLabels.includes('timeout')) riskPenalty += 5;
    if (riskLabels.includes('path_not_found')) riskPenalty += 5;
    riskPenalty = clamp(riskPenalty, 0, 30);

    const valueScore = clamp(frequencyScore + workflowScore + timeSavingScore - riskPenalty, 0, 100);
    const recommendation = recommendationFor(valueScore, errorRate, workflowScore);
    const explanations = [
        `最近范围内调用 ${callCount} 次，覆盖 ${sessionCount} 个会话`,
        workflowScore >= 20
            ? `常和其他工具形成重复链路，工作流潜力 ${workflowScore}/35`
            : `工作流信号较弱，工作流潜力 ${workflowScore}/35`,
        `成功率 ${(successRate * 100).toFixed(1)}%，平均耗时 ${Math.round(tool.avg_duration_ms || 0)}ms`,
    ];
    if (riskLabels.length > 0) {
        explanations.push(`常见失败类型：${riskLabels.join('、')}`);
    }
    if (riskPenalty > 0) {
        explanations.push(`风险扣分 ${riskPenalty}，建议优先排查失败原因`);
    }

    return {
        frequency_score: frequencyScore,
        workflow_score: workflowScore,
        time_saving_score: timeSavingScore,
        risk_penalty: riskPenalty,
        value_score: valueScore,
        recommendation,
        explanations,
    };
}

function normalizeToolRow(row) {
    const success = row.success === 1 || row.success === true;
    return {
        ...row,
        tool_name: row.tool_name || 'unknown',
        success,
        error_type: row.error_type || null,
        duration_ms: Number(row.duration_ms || 0),
    };
}

function buildWorkflowPatterns(rows) {
    const bySession = new Map();
    for (const row of rows) {
        if (!row.session_id || !row.tool_name) continue;
        if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
        bySession.get(row.session_id).push(row);
    }

    const patternMap = new Map();
    const pairCountByTool = new Map();
    const terminalSuccessByTool = new Map();
    const successfulSessionsByTool = new Map();

    for (const calls of bySession.values()) {
        calls.sort((a, b) => {
            const ts = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
            return ts || ((a.id || 0) - (b.id || 0));
        });
        const successSession = calls.length > 0 && calls.every(c => c.success !== false);
        const terminal = calls[calls.length - 1];
        if (terminal && terminal.success !== false) {
            terminalSuccessByTool.set(terminal.tool_name, (terminalSuccessByTool.get(terminal.tool_name) || 0) + 1);
        }

        const seenInSession = new Set();
        for (const call of calls) {
            if (successSession && !seenInSession.has(call.tool_name)) {
                seenInSession.add(call.tool_name);
                successfulSessionsByTool.set(call.tool_name, (successfulSessionsByTool.get(call.tool_name) || 0) + 1);
            }
        }

        for (let size = 2; size <= Math.min(5, calls.length); size++) {
            for (let i = 0; i <= calls.length - size; i++) {
                const slice = calls.slice(i, i + size).map(c => c.tool_name);
                const key = slice.join(' -> ');
                const item = patternMap.get(key) || { pattern: slice, count: 0, success_count: 0, total_duration_ms: 0 };
                item.count += 1;
                if (successSession) item.success_count += 1;
                item.total_duration_ms += calls.slice(i, i + size).reduce((sum, c) => sum + (c.duration_ms || 0), 0);
                patternMap.set(key, item);
            }
        }

        for (let i = 0; i < calls.length - 1; i++) {
            const a = calls[i].tool_name;
            const b = calls[i + 1].tool_name;
            pairCountByTool.set(a, (pairCountByTool.get(a) || 0) + 1);
            pairCountByTool.set(b, (pairCountByTool.get(b) || 0) + 1);
        }
    }

    const workflowPatterns = Array.from(patternMap.values())
        .filter(p => p.count >= 2)
        .map(p => ({
            pattern: p.pattern,
            count: p.count,
            success_rate: p.count > 0 ? p.success_count / p.count : 0,
            avg_duration_ms: p.count > 0 ? Math.round(p.total_duration_ms / p.count) : 0,
            label: labelPattern(p.pattern),
        }))
        .sort((a, b) => b.count - a.count || b.success_rate - a.success_rate)
        .slice(0, 8);

    return { workflowPatterns, pairCountByTool, terminalSuccessByTool, successfulSessionsByTool };
}

function labelPattern(pattern) {
    const lower = pattern.map(p => String(p).toLowerCase());
    if (lower.some(p => p.includes('grep') || p.includes('search')) && lower.some(p => p.includes('read'))) return '代码定位链路';
    if (lower.some(p => p.includes('edit') || p.includes('write')) && lower.some(p => p.includes('bash') || p.includes('shell'))) return '修改验证链路';
    if (lower.some(p => p.includes('mcp')) && lower.some(p => p.includes('read') || p.includes('write'))) return '外部工具协作链路';
    return '可复用工具链路';
}

function buildToolMap(inputRows = []) {
    const rows = inputRows
        .map(normalizeToolRow)
        .filter(row => row.tool_name && ['tool_result', 'tool_error'].includes(row.role || 'tool_result'));

    const { workflowPatterns, pairCountByTool, terminalSuccessByTool, successfulSessionsByTool } = buildWorkflowPatterns(rows);
    const toolMap = new Map();

    for (const row of rows) {
        const key = `${row.source || ''}::${row.tool_name}`;
        const item = toolMap.get(key) || {
            tool_name: row.tool_name,
            tool_type: classifyToolType(row.tool_name),
            source: row.source || '',
            call_count: 0,
            session_ids: new Set(),
            success_count: 0,
            error_count: 0,
            total_duration_ms: 0,
            risk_labels: new Set(),
        };
        item.call_count += 1;
        if (row.session_id) item.session_ids.add(row.session_id);
        if (row.success === false || row.role === 'tool_error') item.error_count += 1;
        else if (row.role !== 'tool_use') item.success_count += 1;
        item.total_duration_ms += row.duration_ms || 0;
        if (row.error_type) item.risk_labels.add(row.error_type);
        toolMap.set(key, item);
    }

    const baseItems = Array.from(toolMap.values()).map(item => ({
        ...item,
        session_count: item.session_ids.size,
        avg_duration_ms: item.call_count > 0 ? item.total_duration_ms / item.call_count : 0,
        risk_labels: Array.from(item.risk_labels),
        common_pair_count: pairCountByTool.get(item.tool_name) || 0,
        terminal_success_count: terminalSuccessByTool.get(item.tool_name) || 0,
        successful_session_count: successfulSessionsByTool.get(item.tool_name) || 0,
    }));

    const context = {
        maxCalls: Math.max(1, ...baseItems.map(item => item.call_count)),
        maxSessions: Math.max(1, ...baseItems.map(item => item.session_count)),
        maxPairCount: Math.max(1, ...baseItems.map(item => item.common_pair_count)),
    };

    const items = baseItems.map(item => {
        const scored = scoreTool(item, context);
        const successRate = (item.success_count + item.error_count) > 0
            ? item.success_count / (item.success_count + item.error_count)
            : 0;
        const errorRate = (item.success_count + item.error_count) > 0
            ? item.error_count / (item.success_count + item.error_count)
            : 0;
        const { session_ids, total_duration_ms, ...plain } = item;
        return {
            ...plain,
            success_rate: successRate,
            error_rate: errorRate,
            avg_duration_ms: Math.round(item.avg_duration_ms || 0),
            ...scored,
        };
    }).sort((a, b) => b.value_score - a.value_score || b.call_count - a.call_count);

    return {
        summary: {
            total_tools: items.length,
            high_value_tools: items.filter(item => item.value_score >= 70).length,
            high_risk_tools: items.filter(item => item.error_rate >= 0.3 || item.risk_penalty >= 20).length,
            workflow_candidates: workflowPatterns.length,
        },
        items,
        workflow_patterns: workflowPatterns,
    };
}

function rangeToSince(range) {
    const now = new Date();
    if (range === 'today') return now.toISOString().slice(0, 10);
    if (range === 'week') {
        const d = new Date(now);
        d.setDate(d.getDate() - 7);
        return d.toISOString().slice(0, 10);
    }
    if (range === 'month') {
        const d = new Date(now);
        d.setMonth(d.getMonth() - 1);
        return d.toISOString().slice(0, 10);
    }
    return null;
}

function queryToolMap(db, options = {}) {
    const where = [`${TOOL_ROLE_SQL}`, 'tool_name IS NOT NULL'];
    const params = [];
    if (options.project) { where.push('project_key = ?'); params.push(options.project); }
    if (options.source) { where.push('source = ?'); params.push(options.source); }
    const since = rangeToSince(options.range || 'week');
    if (since) { where.push('timestamp >= ?'); params.push(since); }

    const rows = db.prepare(`
        SELECT id, source, session_id, timestamp, role, tool_name, success, duration_ms, error_type
        FROM timeline
        WHERE ${where.join(' AND ')}
        ORDER BY session_id ASC, timestamp ASC, id ASC
    `).all(...params);

    return buildToolMap(rows);
}

module.exports = {
    classifyToolType,
    scoreTool,
    buildToolMap,
    queryToolMap,
};
