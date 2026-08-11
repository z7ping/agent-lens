const fs = require('fs');
const os = require('os');
const path = require('path');
const { getCapturePolicy } = require('./privacy');

const DEFAULT_MAX_BYTES = 32 * 1024;

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch (_) { return null; }
}

function findProjectRoot(cwd) {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    if (safeStat(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd || process.cwd());
    current = parent;
  }
}

function parseStringArray(text, key) {
  const match = String(text || '').match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/["']([^"']+)["']/g), item => item[1].trim()).filter(Boolean);
}

function parseNumber(text, key, fallback) {
  const match = String(text || '').match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*(\\d+)`, 'm'));
  return match ? Number(match[1]) : fallback;
}

function readInstructionSettings(codexHome) {
  let config = '';
  try { config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch (_) {}
  return {
    fallbackNames: parseStringArray(config, 'project_doc_fallback_filenames'),
    maxBytes: parseNumber(config, 'project_doc_max_bytes', DEFAULT_MAX_BYTES),
  };
}

function firstNonEmptyFile(directory, names) {
  for (const name of names) {
    const filePath = path.join(directory, name);
    const stat = safeStat(filePath);
    if (!stat?.isFile() || stat.size === 0) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) return { filePath, content, stat };
    } catch (_) {}
  }
  return null;
}

function directoriesFromRoot(root, cwd) {
  const resolvedRoot = path.resolve(root);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedRoot, resolvedCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [resolvedCwd];
  const directories = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function discoverCodexInstructionFiles(cwd, options = {}) {
  const env = options.env || process.env;
  if (getCapturePolicy(env).config === 'off') return [];

  const homeDir = options.homeDir || os.homedir();
  const codexHome = options.codexHome || env.CODEX_HOME || path.join(homeDir, '.codex');
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const projectRoot = options.projectRoot || findProjectRoot(resolvedCwd);
  const settings = readInstructionSettings(codexHome);
  const entries = [];
  let remainingBytes = Math.max(0, settings.maxBytes);

  const candidates = [];
  const global = firstNonEmptyFile(codexHome, ['AGENTS.override.md', 'AGENTS.md']);
  if (global) candidates.push({ ...global, scope: 'global' });
  for (const directory of directoriesFromRoot(projectRoot, resolvedCwd)) {
    const projectFile = firstNonEmptyFile(directory, ['AGENTS.override.md', 'AGENTS.md', ...settings.fallbackNames]);
    if (projectFile) candidates.push({ ...projectFile, scope: 'project' });
  }

  for (const candidate of candidates) {
    if (remainingBytes <= 0) break;
    const raw = Buffer.from(candidate.content, 'utf8');
    const included = raw.subarray(0, remainingBytes);
    if (included.length === 0) break;
    const content = included.toString('utf8');
    entries.push({
      scope: candidate.scope,
      path: candidate.filePath,
      file_name: path.basename(candidate.filePath),
      content,
      bytes: included.length,
      truncated: included.length < raw.length,
      modified_at: candidate.stat.mtime.toISOString(),
      precedence: entries.length,
      project_root: projectRoot,
      cwd: resolvedCwd,
    });
    remainingBytes -= included.length;
  }
  return entries;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  findProjectRoot,
  readInstructionSettings,
  discoverCodexInstructionFiles,
};
