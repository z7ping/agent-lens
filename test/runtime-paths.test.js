const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  getFlatInstalledRuntimePaths,
  getLegacyInstalledRuntimePaths,
  getRuntimePaths,
} = require('../server/runtime-paths');

test('source layout stores runtime files under project .agent-lens directory', () => {
  const projectDir = path.resolve(__dirname, '..');
  const paths = getRuntimePaths({
    layout: 'source',
    projectDir,
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
  });

  assert.equal(paths.appDir, projectDir);
  assert.equal(paths.binDir, null);
  assert.equal(paths.dataDir, path.join(projectDir, '.agent-lens', 'data'));
  assert.equal(paths.logsDir, path.join(projectDir, '.agent-lens', 'logs'));
  assert.equal(paths.stateDir, path.join(projectDir, '.agent-lens', 'state'));
  assert.equal(paths.runDir, path.join(projectDir, '.agent-lens', 'run'));
  assert.equal(paths.dbFile, path.join(projectDir, '.agent-lens', 'data', 'agent-lens.db'));
  assert.equal(paths.projectsFile, path.join(projectDir, '.agent-lens', 'data', 'projects.json'));
  assert.equal(paths.pidFile, path.join(projectDir, '.agent-lens', 'run', 'server.pid'));
  assert.equal(paths.hookTokenFile, path.join(projectDir, '.agent-lens', 'run', 'hook-token'));
});

test('installed layout separates the app and runtime directories under home .agent-lens', () => {
  const paths = getRuntimePaths({
    layout: 'installed',
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
  });

  const rootDir = path.join('C:\\Users\\tester', '.agent-lens');
  assert.equal(paths.rootDir, rootDir);
  assert.equal(paths.appDir, path.join(rootDir, 'app'));
  assert.equal(paths.binDir, path.join(rootDir, 'bin'));
  assert.equal(paths.dataDir, path.join(rootDir, 'data'));
  assert.equal(paths.logsDir, path.join(rootDir, 'logs'));
  assert.equal(paths.stateDir, path.join(rootDir, 'state'));
  assert.equal(paths.runDir, path.join(rootDir, 'run'));
  assert.equal(paths.dbFile, path.join(rootDir, 'data', 'agent-lens.db'));
  assert.equal(paths.pidFile, path.join(rootDir, 'run', 'server.pid'));
  assert.equal(paths.hookTokenFile, path.join(rootDir, 'run', 'hook-token'));
});

test('flat installed layout remains detectable for in-place upgrades', () => {
  const paths = getFlatInstalledRuntimePaths({ homeDir: 'C:\\Users\\tester' });
  const rootDir = path.join('C:\\Users\\tester', '.agent-lens');

  assert.equal(paths.rootDir, rootDir);
  assert.equal(paths.appDir, rootDir);
  assert.equal(paths.dataDir, path.join(rootDir, 'data'));
  assert.equal(paths.pidFile, path.join(rootDir, 'run', 'server.pid'));
});

test('legacy Windows layout remains detectable for data migration', () => {
  const paths = getLegacyInstalledRuntimePaths({
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
  });
  const rootDir = path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens');

  assert.equal(paths.rootDir, rootDir);
  assert.equal(paths.appDir, path.join(rootDir, 'app'));
  assert.equal(paths.dataDir, path.join(rootDir, 'data'));
  assert.equal(paths.logsDir, path.join(rootDir, 'logs'));
  assert.equal(paths.stateDir, path.join(rootDir, 'state'));
  assert.equal(paths.pidFile, path.join(rootDir, 'run', 'server.pid'));
});
