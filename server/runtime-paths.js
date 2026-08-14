const fs = require('fs');
const os = require('os');
const path = require('path');

function isSourceLayout(baseDir = __dirname) {
  return path.basename(baseDir) === 'server';
}

function getProjectDir(baseDir = __dirname) {
  return isSourceLayout(baseDir) ? path.dirname(baseDir) : baseDir;
}

function getInstalledRoot(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  return path.join(homeDir, '.agent-lens');
}

function getFlatInstalledRuntimePaths(options = {}) {
  const rootDir = options.rootDir || getInstalledRoot(options);
  return buildPaths({
    rootDir,
    appDir: rootDir,
    binDir: path.join(rootDir, 'bin'),
    dataDir: path.join(rootDir, 'data'),
    logsDir: path.join(rootDir, 'logs'),
    stateDir: path.join(rootDir, 'state'),
    runDir: path.join(rootDir, 'run'),
  });
}

function getLegacyInstalledRuntimePaths(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  let rootDir;
  let stateRoot;

  if (platform === 'win32') {
    rootDir = path.join(
      options.localAppData || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'),
      'AgentLens',
    );
    stateRoot = rootDir;
  } else if (platform === 'darwin') {
    rootDir = path.join(homeDir, 'Library', 'Application Support', 'AgentLens');
    stateRoot = rootDir;
  } else {
    rootDir = path.join(
      options.xdgDataHome || process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'),
      'agent-lens',
    );
    stateRoot = path.join(
      options.xdgStateHome || process.env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state'),
      'agent-lens',
    );
  }

  return buildPaths({
    rootDir,
    appDir: path.join(rootDir, 'app'),
    binDir: path.join(rootDir, 'bin'),
    dataDir: path.join(rootDir, 'data'),
    logsDir: path.join(stateRoot, 'logs'),
    stateDir: path.join(stateRoot, 'state'),
    runDir: path.join(stateRoot, 'run'),
  });
}

function getRuntimePaths(options = {}) {
  const layout = options.layout || (isSourceLayout(options.baseDir || __dirname) ? 'source' : 'installed');
  const projectDir = options.projectDir || getProjectDir(options.baseDir || __dirname);

  if (layout === 'source') {
    const rootDir = path.join(projectDir, '.agent-lens');
    return buildPaths({
      rootDir,
      appDir: projectDir,
      binDir: null,
      dataDir: path.join(rootDir, 'data'),
      logsDir: path.join(rootDir, 'logs'),
      stateDir: path.join(rootDir, 'state'),
      runDir: path.join(rootDir, 'run'),
    });
  }

  const rootDir = options.rootDir || getInstalledRoot(options);
  return buildPaths({
    rootDir,
    appDir: path.join(rootDir, 'app'),
    binDir: path.join(rootDir, 'bin'),
    dataDir: path.join(rootDir, 'data'),
    logsDir: path.join(rootDir, 'logs'),
    stateDir: path.join(rootDir, 'state'),
    runDir: path.join(rootDir, 'run'),
  });
}

function buildPaths(dirs) {
  return {
    ...dirs,
    binDir: Object.prototype.hasOwnProperty.call(dirs, 'binDir') ? dirs.binDir : path.join(dirs.rootDir, 'bin'),
    hooksDir: path.join(dirs.appDir, 'hooks'),
    adaptersDir: path.join(dirs.appDir, 'adapters'),
    importersDir: path.join(dirs.appDir, 'importers'),
    distDir: path.join(dirs.appDir, 'dist'),
    dbFile: path.join(dirs.dataDir, 'agent-lens.db'),
    projectsFile: path.join(dirs.dataDir, 'projects.json'),
    pidFile: path.join(dirs.runDir, 'server.pid'),
    hookTokenFile: path.join(dirs.runDir, 'hook-token'),
    installLockFile: path.join(dirs.runDir, 'install.lock'),
  };
}

function ensureRuntimeDirs(paths = getRuntimePaths()) {
  for (const dir of [paths.rootDir, paths.binDir, paths.dataDir, paths.logsDir, paths.stateDir, paths.runDir].filter(Boolean)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  getRuntimePaths,
  ensureRuntimeDirs,
  isSourceLayout,
  getProjectDir,
  getInstalledRoot,
  getFlatInstalledRuntimePaths,
  getLegacyInstalledRuntimePaths,
};
