#!/usr/bin/env node
/**
 * 共享配置 — 端口号的唯一来源
 */

const DEFAULT_PORT = 56789;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OVERVIEW_SCAN_INTERVAL_MS = parseInt(
    process.env.AGENT_LENS_OVERVIEW_SCAN_INTERVAL_MS || String(10 * 60 * 1000),
    10
);

module.exports = { DEFAULT_PORT, DEFAULT_HOST, DEFAULT_OVERVIEW_SCAN_INTERVAL_MS };
