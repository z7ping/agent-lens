const fs = require('fs');
const path = require('path');

const APP_ROOT_FILES = [
  'server.js',
  'cli.js',
  'db.js',
  'config.js',
  'runtime-paths.js',
  'install-layout.js',
  'agent-lens-db.js',
  'paths.js',
  'install-hooks.js',
  'schema.sql',
  'routes.js',
  'tool-map.js',
  'overview.js',
  'sources-status.js',
  'app-info.js',
];

const APP_DIRECTORIES = ['adapters', 'hooks', 'importers', 'dist'];
const APP_METADATA_FILES = ['package.json', 'README.md', 'CHANGELOG.md'];
const FLAT_LAYOUT_FILES = [...APP_ROOT_FILES, ...APP_METADATA_FILES, 'package-lock.json', 'agent-lens.cmd'];
const FLAT_LAYOUT_DIRECTORIES = [...APP_DIRECTORIES, 'node_modules'];

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeTree(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(source, target) {
  if (!fs.existsSync(source)) return false;
  mkdirp(path.dirname(target));
  fs.copyFileSync(source, target);
  return true;
}

function copyDirectory(source, target) {
  if (!fs.existsSync(source)) return false;
  mkdirp(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
    else if (entry.isFile()) copyFile(sourcePath, targetPath);
  }
  return true;
}

function getApplicationSource(projectDir) {
  const serverDir = path.join(projectDir, 'server');
  return fs.existsSync(path.join(serverDir, 'cli.js')) ? serverDir : projectDir;
}

function stageApplication(projectDir, stageAppDir) {
  removeTree(stageAppDir);
  mkdirp(stageAppDir);

  const appSource = getApplicationSource(projectDir);
  for (const file of APP_ROOT_FILES) {
    copyFile(path.join(appSource, file), path.join(stageAppDir, file));
  }
  for (const dir of ['adapters', 'hooks', 'importers']) {
    copyDirectory(path.join(appSource, dir), path.join(stageAppDir, dir));
  }
  copyDirectory(path.join(projectDir, 'dist'), path.join(stageAppDir, 'dist'));
  for (const file of APP_METADATA_FILES) {
    copyFile(path.join(projectDir, file), path.join(stageAppDir, file));
  }

  for (const required of ['cli.js', 'server.js', 'runtime-paths.js', 'package.json']) {
    if (!fs.existsSync(path.join(stageAppDir, required))) {
      throw new Error(`暂存程序缺少必要文件: ${required}`);
    }
  }
  if (!fs.existsSync(path.join(stageAppDir, 'dist', 'index.html'))) {
    throw new Error('暂存程序缺少 dist/index.html');
  }
}

function mergeMissingFiles(sourceDir, targetDir, relativeDir = '') {
  const result = { copied: [], conflicts: [] };
  if (!fs.existsSync(sourceDir)) return result;
  mkdirp(targetDir);

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      const nested = mergeMissingFiles(sourcePath, targetPath, relativePath);
      result.copied.push(...nested.copied);
      result.conflicts.push(...nested.conflicts);
    } else if (entry.isFile()) {
      if (fs.existsSync(targetPath)) {
        result.conflicts.push(relativePath);
      } else {
        copyFile(sourcePath, targetPath);
        result.copied.push(relativePath);
      }
    }
  }
  return result;
}

function migrateLegacyRuntimeData(legacyPaths, targetPaths) {
  const result = { copied: [], conflicts: [] };
  for (const key of ['dataDir', 'logsDir', 'stateDir']) {
    const sourceDir = legacyPaths[key];
    const targetDir = targetPaths[key];
    if (!sourceDir || !targetDir || path.resolve(sourceDir) === path.resolve(targetDir)) continue;
    const merged = mergeMissingFiles(sourceDir, targetDir, path.basename(targetDir));
    result.copied.push(...merged.copied);
    result.conflicts.push(...merged.conflicts);
  }
  return result;
}

function activateStagedApplication(stageAppDir, targetAppDir, installRoot) {
  const rollbackRoot = path.join(installRoot, '.rollback');
  const backupDir = path.join(rollbackRoot, `app-${Date.now()}`);
  let hasBackup = false;

  mkdirp(path.dirname(targetAppDir));
  if (fs.existsSync(targetAppDir)) {
    mkdirp(rollbackRoot);
    fs.renameSync(targetAppDir, backupDir);
    hasBackup = true;
  }

  try {
    fs.renameSync(stageAppDir, targetAppDir);
  } catch (error) {
    if (hasBackup && !fs.existsSync(targetAppDir)) fs.renameSync(backupDir, targetAppDir);
    throw error;
  }

  return hasBackup ? backupDir : null;
}

function restoreBackupApplication(backupDir, targetAppDir, installRoot) {
  if (!backupDir || !fs.existsSync(backupDir)) return false;

  const rollbackRoot = path.join(installRoot, '.rollback');
  const failedDir = path.join(rollbackRoot, `failed-app-${Date.now()}`);
  let hasFailedApp = false;

  mkdirp(path.dirname(targetAppDir));
  if (fs.existsSync(targetAppDir)) {
    mkdirp(rollbackRoot);
    fs.renameSync(targetAppDir, failedDir);
    hasFailedApp = true;
  }

  try {
    fs.renameSync(backupDir, targetAppDir);
  } catch (error) {
    if (hasFailedApp && !fs.existsSync(targetAppDir)) fs.renameSync(failedDir, targetAppDir);
    throw error;
  }

  if (hasFailedApp) removeTree(failedDir);
  return true;
}

function cleanupFlatApplication(installRoot) {
  const removed = [];
  for (const name of FLAT_LAYOUT_FILES) {
    const target = path.join(installRoot, name);
    if (!fs.existsSync(target)) continue;
    fs.unlinkSync(target);
    removed.push(name);
  }
  for (const name of FLAT_LAYOUT_DIRECTORIES) {
    const target = path.join(installRoot, name);
    if (!fs.existsSync(target)) continue;
    removeTree(target);
    removed.push(`${name}/`);
  }
  return removed;
}

function hasFlatApplication(installRoot) {
  return fs.existsSync(path.join(installRoot, 'cli.js')) ||
    fs.existsSync(path.join(installRoot, 'server.js')) ||
    fs.existsSync(path.join(installRoot, 'node_modules'));
}

module.exports = {
  APP_ROOT_FILES,
  APP_DIRECTORIES,
  APP_METADATA_FILES,
  FLAT_LAYOUT_FILES,
  FLAT_LAYOUT_DIRECTORIES,
  activateStagedApplication,
  cleanupFlatApplication,
  copyDirectory,
  copyFile,
  hasFlatApplication,
  mergeMissingFiles,
  migrateLegacyRuntimeData,
  removeTree,
  restoreBackupApplication,
  stageApplication,
};
