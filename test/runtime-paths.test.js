const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { getRuntimePaths } = require('../server/runtime-paths');

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
  assert.equal(paths.dataDir, path.join(projectDir, '.agent-lens', 'data'));
  assert.equal(paths.logsDir, path.join(projectDir, '.agent-lens', 'logs'));
  assert.equal(paths.stateDir, path.join(projectDir, '.agent-lens', 'state'));
  assert.equal(paths.runDir, path.join(projectDir, '.agent-lens', 'run'));
  assert.equal(paths.dbFile, path.join(projectDir, '.agent-lens', 'data', 'agent-lens.db'));
  assert.equal(paths.projectsFile, path.join(projectDir, '.agent-lens', 'data', 'projects.json'));
  assert.equal(paths.pidFile, path.join(projectDir, '.agent-lens', 'run', 'server.pid'));
});

test('windows install layout separates app and runtime directories under LocalAppData', () => {
  const paths = getRuntimePaths({
    layout: 'installed',
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    localAppData: 'C:\\Users\\tester\\AppData\\Local',
  });

  assert.equal(paths.rootDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens'));
  assert.equal(paths.appDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens', 'app'));
  assert.equal(paths.dataDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens', 'data'));
  assert.equal(paths.logsDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens', 'logs'));
  assert.equal(paths.stateDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens', 'state'));
  assert.equal(paths.runDir, path.join('C:\\Users\\tester\\AppData\\Local', 'AgentLens', 'run'));
});
