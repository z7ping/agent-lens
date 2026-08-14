const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getRuntimePaths } = require('./runtime-paths');
const { pi } = require('./paths');
const { diagnosePiRuntimeExtension } = require('./sources-status');

const MANAGED_BY = 'agent-lens';
const EXTENSION_NAME = 'agent-lens-runtime';
const EXTENSION_FILE_NAME = 'pi-runtime-extension.js';

function readJsonFile(filePath) {
  try {
    return { exists: fs.existsSync(filePath), data: fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {} };
  } catch (error) {
    return { exists: true, error };
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fileSha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return '';
  }
}

function readPackageVersion(appDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch (_) {
    return '';
  }
}

function expandHomePath(input, homeDir = os.homedir()) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (text === '~') return homeDir;
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homeDir, text.slice(2));
  return text;
}

function resolvePiPath(input, baseDir, homeDir = os.homedir()) {
  const expanded = expandHomePath(input, homeDir);
  if (!expanded) return '';
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function entryPath(entry) {
  if (typeof entry === 'string') return entry.startsWith('+') ? entry.slice(1) : entry;
  if (!entry || typeof entry !== 'object') return '';
  const raw = String(entry.path || entry.source || entry.module || '');
  return raw.startsWith('+') ? raw.slice(1) : raw;
}

function isManagedEntry(entry, extensionFile, agentDir, homeDir = os.homedir()) {
  if (!entry) return false;
  if (typeof entry === 'object' && !Array.isArray(entry)) {
    if (entry.managed_by === MANAGED_BY || entry.name === EXTENSION_NAME) return true;
  }
  const rawPath = entryPath(entry);
  if (!rawPath) return false;
  const resolved = resolvePiPath(rawPath, agentDir, homeDir);
  return Boolean(resolved && path.resolve(resolved) === path.resolve(extensionFile));
}

function makeManagedEntry(extensionFile, runtime, options = {}) {
  return {
    name: EXTENSION_NAME,
    path: extensionFile,
    managed_by: MANAGED_BY,
    version: options.version || readPackageVersion(runtime.appDir),
    sha256: fileSha256(extensionFile),
  };
}

function backupSettings(settingsPath, options = {}) {
  if (!fs.existsSync(settingsPath)) return '';
  const stamp = options.timestamp || new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(path.dirname(settingsPath), `settings.agent-lens-backup-${stamp}.json`);
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function resolveTargets(options = {}) {
  const runtime = options.runtimePaths || getRuntimePaths({ baseDir: options.baseDir || __dirname });
  const agentDir = options.agentDir || pi.agentDir;
  const settingsPath = options.settingsPath || path.join(agentDir, 'settings.json');
  const extensionFile = options.extensionFile || path.join(runtime.hooksDir, EXTENSION_FILE_NAME);
  return { runtime, agentDir, settingsPath, extensionFile };
}

function getPiExtensionStatus(options = {}) {
  const targets = resolveTargets(options);
  const diagnostic = diagnosePiRuntimeExtension({
    ...options,
    runtimePaths: targets.runtime,
    agentDir: targets.agentDir,
    settingsPath: targets.settingsPath,
    extensionFile: targets.extensionFile,
  });
  return {
    ...diagnostic,
    version: readPackageVersion(targets.runtime.appDir),
    sha256: fileSha256(targets.extensionFile),
  };
}

function installPiExtension(options = {}) {
  const targets = resolveTargets(options);
  if (!fs.existsSync(targets.extensionFile)) {
    throw new Error(`缺少 Pi 运行时扩展文件: ${targets.extensionFile}`);
  }

  const loaded = readJsonFile(targets.settingsPath);
  if (loaded.error) throw new Error(`Pi settings.json 不是有效 JSON，已停止修改: ${loaded.error.message}`);
  const settings = loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data) ? loaded.data : {};
  if (settings.extensions !== undefined && !Array.isArray(settings.extensions)) {
    throw new Error('Pi settings.json 的 extensions 字段不是数组，已停止修改');
  }
  const existing = Array.isArray(settings.extensions) ? settings.extensions : [];
  const managedEntry = makeManagedEntry(targets.extensionFile, targets.runtime, options);
  const kept = existing.filter(entry => !isManagedEntry(entry, targets.extensionFile, targets.agentDir, options.homeDir));
  const nextExtensions = [...kept, managedEntry];
  const changed = JSON.stringify(nextExtensions) !== JSON.stringify(existing);

  settings.extensions = nextExtensions;
  const backupPath = changed ? backupSettings(targets.settingsPath, options) : '';
  if (changed) writeJsonFile(targets.settingsPath, settings);

  return {
    action: changed ? 'installed' : 'unchanged',
    changed,
    backupPath,
    settingsPath: targets.settingsPath,
    extensionFile: targets.extensionFile,
    status: getPiExtensionStatus(options),
  };
}

function uninstallPiExtension(options = {}) {
  const targets = resolveTargets(options);
  const loaded = readJsonFile(targets.settingsPath);
  if (loaded.error) throw new Error(`Pi settings.json 不是有效 JSON，已停止修改: ${loaded.error.message}`);
  if (!loaded.exists) {
    return { action: 'missing_settings', changed: false, settingsPath: targets.settingsPath, extensionFile: targets.extensionFile };
  }
  const settings = loaded.data && typeof loaded.data === 'object' && !Array.isArray(loaded.data) ? loaded.data : {};
  if (settings.extensions !== undefined && !Array.isArray(settings.extensions)) {
    throw new Error('Pi settings.json 的 extensions 字段不是数组，已停止修改');
  }
  const existing = Array.isArray(settings.extensions) ? settings.extensions : [];
  const kept = existing.filter(entry => !isManagedEntry(entry, targets.extensionFile, targets.agentDir, options.homeDir));
  const changed = kept.length !== existing.length;
  if (changed) {
    const backupPath = backupSettings(targets.settingsPath, options);
    if (kept.length) settings.extensions = kept;
    else delete settings.extensions;
    writeJsonFile(targets.settingsPath, settings);
    return {
      action: 'uninstalled',
      changed: true,
      removed: existing.length - kept.length,
      backupPath,
      settingsPath: targets.settingsPath,
      extensionFile: targets.extensionFile,
      status: getPiExtensionStatus(options),
    };
  }
  return {
    action: 'not_installed',
    changed: false,
    removed: 0,
    settingsPath: targets.settingsPath,
    extensionFile: targets.extensionFile,
    status: getPiExtensionStatus(options),
  };
}

function upgradePiExtension(options = {}) {
  const result = installPiExtension(options);
  return { ...result, action: result.changed ? 'upgraded' : 'unchanged' };
}

module.exports = {
  EXTENSION_FILE_NAME,
  EXTENSION_NAME,
  MANAGED_BY,
  getPiExtensionStatus,
  installPiExtension,
  isManagedEntry,
  uninstallPiExtension,
  upgradePiExtension,
};
