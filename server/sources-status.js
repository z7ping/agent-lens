#!/usr/bin/env node
/**
 * sources-status.js - 各来源采集状态检测
 *
 * 判断每个工具：
 *  - historyAvailable：历史 JSONL 是否可导入（不依赖 hook）
 *  - hookInstalled   ：AgentLens 的实时 hook 是否已接入该工具
 *  - sessionFiles    ：历史会话文件数（仅统计用）
 */

const fs = require('fs');
const path = require('path');
const { claudeCode, codex, agentLens } = require('./paths');

function countJsonlRecursive(dir) {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) count += countJsonlRecursive(full);
            else if (entry.name.endsWith('.jsonl')) count++;
        }
    } catch (_) {}
    return count;
}

/** 判断 hook 配置中是否引用了 agent-lens 自己的钩子脚本 */
function hooksReferenceAgentLens(hookConfigText) {
    if (!hookConfigText) return false;
    return /agent-lens|prelog\.js|hooks[\\/]log\.js|\.agent-lens/i.test(hookConfigText);
}

function detectSourceStatus() {
    // ─── Claude Code ───
    const claudeSettingsText = fs.existsSync(claudeCode.settingsFile) ? safeRead(claudeCode.settingsFile) : '';
    const claudeHookInstalled = hooksReferenceAgentLens(claudeSettingsText);

    // ─── Codex ───
    const codexHooksText = fs.existsSync(codex.hooksFile) ? safeRead(codex.hooksFile) : '';
    const codexHookInstalled = hooksReferenceAgentLens(codexHooksText);

    const agentLensInstalled = fs.existsSync(path.join(agentLens.appDir || agentLens.home, 'hooks')) ||
        fs.existsSync(path.join(agentLens.appDir || agentLens.home, 'install-hooks.js'));

    return {
        'claude-code': {
            historyAvailable: countJsonlRecursive(claudeCode.projectsDir) > 0,
            hookInstalled: claudeHookInstalled,
            sessionFiles: countJsonlRecursive(claudeCode.projectsDir),
            dataDir: claudeCode.projectsDir,
        },
        codex: {
            historyAvailable: countJsonlRecursive(codex.sessionsDir) > 0,
            hookInstalled: codexHookInstalled,
            sessionFiles: countJsonlRecursive(codex.sessionsDir),
            dataDir: codex.sessionsDir,
        },
        agentLensInstalled,
    };
}

function safeRead(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}

module.exports = { detectSourceStatus, hooksReferenceAgentLens };
