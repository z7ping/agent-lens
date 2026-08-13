const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  activateStagedApplication,
  cleanupFlatApplication,
  hasFlatApplication,
  migrateLegacyRuntimeData,
  restoreBackupApplication,
  stageApplication,
} = require('../server/install-layout');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-layout-test-'));
}

test('legacy data migration copies missing files without overwriting target data', () => {
  const root = makeTempRoot();
  const legacy = {
    dataDir: path.join(root, 'legacy', 'data'),
    logsDir: path.join(root, 'legacy', 'logs'),
    stateDir: path.join(root, 'legacy', 'state'),
  };
  const target = {
    dataDir: path.join(root, 'target', 'data'),
    logsDir: path.join(root, 'target', 'logs'),
    stateDir: path.join(root, 'target', 'state'),
  };

  fs.mkdirSync(legacy.dataDir, { recursive: true });
  fs.mkdirSync(target.dataDir, { recursive: true });
  fs.writeFileSync(path.join(legacy.dataDir, 'agent-lens.db'), 'legacy');
  fs.writeFileSync(path.join(legacy.dataDir, 'projects.json'), 'legacy-projects');
  fs.writeFileSync(path.join(target.dataDir, 'agent-lens.db'), 'target');

  const result = migrateLegacyRuntimeData(legacy, target);

  assert.equal(fs.readFileSync(path.join(target.dataDir, 'agent-lens.db'), 'utf8'), 'target');
  assert.equal(fs.readFileSync(path.join(target.dataDir, 'projects.json'), 'utf8'), 'legacy-projects');
  assert.ok(result.conflicts.includes(path.join('data', 'agent-lens.db')));
  assert.ok(result.copied.includes(path.join('data', 'projects.json')));
});

test('staged application activation keeps the previous app available for rollback', () => {
  const root = makeTempRoot();
  const targetApp = path.join(root, 'app');
  const stagedApp = path.join(root, '.update', 'app');
  fs.mkdirSync(targetApp, { recursive: true });
  fs.mkdirSync(stagedApp, { recursive: true });
  fs.writeFileSync(path.join(targetApp, 'version.txt'), 'old');
  fs.writeFileSync(path.join(stagedApp, 'version.txt'), 'new');

  const backupDir = activateStagedApplication(stagedApp, targetApp, root);

  assert.equal(fs.readFileSync(path.join(targetApp, 'version.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(backupDir, 'version.txt'), 'utf8'), 'old');
});

test('failed application activation restores the previous app without retaining the failed copy', () => {
  const root = makeTempRoot();
  const targetApp = path.join(root, 'app');
  const stagedApp = path.join(root, '.update', 'app');
  fs.mkdirSync(targetApp, { recursive: true });
  fs.mkdirSync(stagedApp, { recursive: true });
  fs.writeFileSync(path.join(targetApp, 'version.txt'), 'old');
  fs.writeFileSync(path.join(stagedApp, 'version.txt'), 'new');

  const backupDir = activateStagedApplication(stagedApp, targetApp, root);
  const restored = restoreBackupApplication(backupDir, targetApp, root);

  assert.equal(restored, true);
  assert.equal(fs.readFileSync(path.join(targetApp, 'version.txt'), 'utf8'), 'old');
  assert.equal(fs.existsSync(backupDir), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.rollback')), []);
});

test('flat application cleanup preserves runtime data and the new app layout', () => {
  const root = makeTempRoot();
  for (const dir of ['node_modules', 'dist', 'adapters', 'data', 'logs', 'state', 'run', 'app', 'bin']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'cli.js'), 'flat');
  fs.writeFileSync(path.join(root, 'server.js'), 'flat');
  fs.writeFileSync(path.join(root, 'data', 'agent-lens.db'), 'data');
  fs.writeFileSync(path.join(root, 'app', 'cli.js'), 'new');
  fs.writeFileSync(path.join(root, 'bin', 'agent-lens.cmd'), 'shim');

  assert.equal(hasFlatApplication(root), true);
  const removed = cleanupFlatApplication(root);

  assert.ok(removed.includes('cli.js'));
  assert.ok(removed.includes('node_modules/'));
  assert.equal(hasFlatApplication(root), false);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'agent-lens.db'), 'utf8'), 'data');
  assert.equal(fs.readFileSync(path.join(root, 'app', 'cli.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(root, 'bin', 'agent-lens.cmd'), 'utf8'), 'shim');
});

test('application staging copies runtime files without local state or dependencies', () => {
  const projectRoot = path.join(__dirname, '..');
  const tempRoot = makeTempRoot();
  const fixtureProject = path.join(tempRoot, 'project');
  const stagedApp = path.join(tempRoot, 'app');

  fs.cpSync(path.join(projectRoot, 'server'), path.join(fixtureProject, 'server'), { recursive: true });
  fs.mkdirSync(path.join(fixtureProject, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(fixtureProject, 'dist', 'index.html'), '<!doctype html>');
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md']) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(fixtureProject, file));
  }

  stageApplication(fixtureProject, stagedApp);

  for (const required of [
    'cli.js',
    'server.js',
    'runtime-paths.js',
    'install-layout.js',
    'install-lock.js',
    'codex-lifecycle.js',
    'codex-context.js',
    'event-model.js',
    'migrations.js',
    'privacy.js',
    'security.js',
    'package.json',
    path.join('hooks', 'prelog.js'),
    path.join('hooks', 'codex-lifecycle.js'),
    path.join('hooks', 'windows-hook-runner.exe'),
    path.join('hooks', 'windows-hook-runner.cs'),
    path.join('adapters', 'index.js'),
    path.join('dist', 'index.html'),
  ]) {
    assert.equal(fs.existsSync(path.join(stagedApp, required)), true, `${required} should be staged`);
  }
  for (const forbidden of ['node_modules', 'package-lock.json', 'data', 'logs', 'state', 'run']) {
    assert.equal(fs.existsSync(path.join(stagedApp, forbidden)), false, `${forbidden} should not be staged`);
  }
});
