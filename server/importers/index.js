#!/usr/bin/env node
/**
 * importers/index.js - JSONL 历史导入器注册表
 * 管理 Claude Code / Codex 历史导入器，提供统一的启动/停止入口。
 */

const claudeCodeImporter = require('./claude-code');
const codexImporter = require('./codex');

const importers = [claudeCodeImporter, codexImporter];

function startAll() {
    for (const importer of importers) {
        try { importer.startPolling(); } catch (_) {}
    }
}

function stopAll() {
    for (const importer of importers) {
        try { importer.stopPolling(); } catch (_) {}
    }
}

function getAllImporters() {
    return importers;
}

module.exports = { startAll, stopAll, getAllImporters, claudeCodeImporter, codexImporter };
