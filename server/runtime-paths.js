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
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'win32') {
    return path.join(options.localAppData || process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'AgentLens');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'AgentLens');
  }
  const dataHome = options.xdgDataHome || process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
  return path.join(dataHome, 'agent-lens');
}

function getInstalledStateRoot(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  if (platform === 'win32') return getInstalledRoot(options);
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'AgentLens');
  const stateHome = options.xdgStateHome || process.env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state');
  return path.join(stateHome, 'agent-lens');
}

function getRuntimePaths(options = {}) {
  const layout = options.layout || (isSourceLayout(options.baseDir || __dirname) ? 'source' : 'installed');
  const projectDir = options.projectDir || getProjectDir(options.baseDir || __dirname);

  if (layout === 'source') {
    const rootDir = path.join(projectDir, '.agent-lens');
    return buildPaths({
      rootDir,
      appDir: projectDir,
      dataDir: path.join(rootDir, 'data'),
      logsDir: path.join(rootDir, 'logs'),
      stateDir: path.join(rootDir, 'state'),
      runDir: path.join(rootDir, 'run'),
    });
  }

  const rootDir = options.rootDir || getInstalledRoot(options);
  const stateRoot = options.stateRoot || getInstalledStateRoot(options);
  return buildPaths({
    rootDir,
    appDir: path.join(rootDir, 'app'),
    dataDir: path.join(rootDir, 'data'),
    logsDir: path.join(stateRoot, 'logs'),
    stateDir: path.join(stateRoot, 'state'),
    runDir: path.join(stateRoot, 'run'),
  });
}

function buildPaths(dirs) {
  return {
    ...dirs,
    hooksDir: path.join(dirs.appDir, 'hooks'),
    adaptersDir: path.join(dirs.appDir, 'adapters'),
    importersDir: path.join(dirs.appDir, 'importers'),
    distDir: path.join(dirs.appDir, 'dist'),
    dbFile: path.join(dirs.dataDir, 'agent-lens.db'),
    projectsFile: path.join(dirs.dataDir, 'projects.json'),
    pidFile: path.join(dirs.runDir, 'server.pid'),
  };
}

function ensureRuntimeDirs(paths = getRuntimePaths()) {
  for (const dir of [paths.rootDir, paths.appDir, paths.dataDir, paths.logsDir, paths.stateDir, paths.runDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  getRuntimePaths,
  ensureRuntimeDirs,
  isSourceLayout,
  getProjectDir,
  getInstalledRoot,
};
