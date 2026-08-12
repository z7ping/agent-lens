#!/usr/bin/env node
/**
 * Codex 生命周期 Hook。
 *
 * 该入口只做被动采集：不批准、不阻断、不改写工具或提示词，也不向模型追加上下文。
 * Stop/SubagentStop 按 Codex 契约返回中性的空 JSON 对象。
 */

const fs = require('fs');
const path = require('path');
const { getAdapter } = require('../adapters');
const { neutralHookOutput } = require('../codex-lifecycle');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
ensureRuntimeDirs(RUNTIME_PATHS);

function logError(error) {
  try {
    const message = error?.stack || error?.message || String(error);
    fs.appendFileSync(
      path.join(RUNTIME_PATHS.logsDir, 'trace_error.log'),
      `[${new Date().toISOString()}] Codex lifecycle: ${message}\n`,
      'utf8',
    );
  } catch (_) {}
}

function eventNameFromRaw(raw) {
  try { return JSON.parse(raw)?.hook_event_name || ''; } catch (_) {}
  const match = String(raw || '').match(/"hook_event_name"\s*:\s*"([^"]+)"/);
  return match ? match[1] : '';
}

async function processLifecyclePayload(data, adapter = getAdapter('codex')) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const eventName = data.hook_event_name || '';
  if (adapter && typeof adapter.lifecycle === 'function') await adapter.lifecycle(data);
  return neutralHookOutput(eventName);
}

async function handleRawInput(raw, adapter = getAdapter('codex')) {
  const eventName = eventNameFromRaw(raw);
  try {
    if (!String(raw || '').trim()) return neutralHookOutput(eventName);
    const data = JSON.parse(raw);
    return await processLifecyclePayload(data, adapter);
  } catch (error) {
    logError(error);
    return neutralHookOutput(eventName);
  }
}

function main() {
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = logError;
  try {
    const guard = require('./server-guard');
    guard.ensureServerRunning(BASE_DIR);
  } catch (_) {}

  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('error', logError);
  process.stdin.on('end', async () => {
    try {
      const output = await handleRawInput(Buffer.concat(chunks).toString('utf8'));
      if (output) process.stdout.write(output);
    } finally {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    }
  });
}

if (require.main === module) main();

module.exports = {
  eventNameFromRaw,
  processLifecyclePayload,
  handleRawInput,
};
