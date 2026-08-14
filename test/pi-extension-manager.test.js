const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  installPiExtension,
  uninstallPiExtension,
  upgradePiExtension,
} = require('../server/pi-extension-manager');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-ext-'));
  const appDir = path.join(root, 'app');
  const hooksDir = path.join(appDir, 'hooks');
  const agentDir = path.join(root, 'pi-agent');
  const settingsPath = path.join(agentDir, 'settings.json');
  const extensionFile = path.join(hooksDir, 'pi-runtime-extension.js');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: '0.7.0-test' }));
  fs.writeFileSync(extensionFile, 'module.exports = {};');
  return {
    root,
    appDir,
    hooksDir,
    agentDir,
    settingsPath,
    extensionFile,
    runtimePaths: { appDir, hooksDir },
  };
}

function readSettings(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('installs Pi runtime extension idempotently and preserves existing entries', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.settingsPath, JSON.stringify({
    extensions: ['+external-extension/index.ts'],
  }, null, 2));

  const first = installPiExtension({ ...fixture, timestamp: '2026-08-14T00-00-00-000Z' });
  assert.equal(first.action, 'installed');
  assert.equal(first.changed, true);
  assert.ok(first.backupPath.endsWith('settings.agent-lens-backup-2026-08-14T00-00-00-000Z.json'));

  const settings = readSettings(fixture.settingsPath);
  assert.equal(settings.extensions.length, 2);
  assert.equal(settings.extensions[0], '+external-extension/index.ts');
  assert.equal(settings.extensions[1].managed_by, 'agent-lens');
  assert.equal(settings.extensions[1].name, 'agent-lens-runtime');
  assert.equal(settings.extensions[1].path, fixture.extensionFile);
  assert.equal(settings.extensions[1].version, '0.7.0-test');
  assert.match(settings.extensions[1].sha256, /^[a-f0-9]{64}$/);

  const second = installPiExtension({ ...fixture, timestamp: '2026-08-14T00-00-01-000Z' });
  assert.equal(second.action, 'unchanged');
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, '');
  assert.equal(readSettings(fixture.settingsPath).extensions.length, 2);
});

test('upgrades stale managed Pi extension metadata without touching user extensions', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.settingsPath, JSON.stringify({
    extensions: [
      { name: 'keep-me', path: 'external.js' },
      { name: 'agent-lens-runtime', managed_by: 'agent-lens', path: 'old.js', version: '0.6.0', sha256: 'old' },
    ],
  }, null, 2));

  const result = upgradePiExtension({ ...fixture, timestamp: '2026-08-14T00-00-02-000Z' });
  const settings = readSettings(fixture.settingsPath);

  assert.equal(result.action, 'upgraded');
  assert.equal(settings.extensions.length, 2);
  assert.deepEqual(settings.extensions[0], { name: 'keep-me', path: 'external.js' });
  assert.equal(settings.extensions[1].path, fixture.extensionFile);
  assert.equal(settings.extensions[1].version, '0.7.0-test');
});

test('uninstalls only AgentLens managed Pi extension entries', () => {
  const fixture = makeFixture();
  fs.writeFileSync(fixture.settingsPath, JSON.stringify({
    extensions: [
      '+external-extension/index.ts',
      { name: 'agent-lens-runtime', managed_by: 'agent-lens', path: fixture.extensionFile },
    ],
  }, null, 2));

  const result = uninstallPiExtension({ ...fixture, timestamp: '2026-08-14T00-00-03-000Z' });
  const settings = readSettings(fixture.settingsPath);

  assert.equal(result.action, 'uninstalled');
  assert.equal(result.removed, 1);
  assert.deepEqual(settings.extensions, ['+external-extension/index.ts']);
});

test('refuses to modify damaged or unknown Pi settings schemas', () => {
  const damaged = makeFixture();
  fs.writeFileSync(damaged.settingsPath, '{bad json');
  assert.throws(
    () => installPiExtension(damaged),
    /不是有效 JSON/,
  );
  assert.equal(fs.readFileSync(damaged.settingsPath, 'utf8'), '{bad json');

  const unknown = makeFixture();
  fs.writeFileSync(unknown.settingsPath, JSON.stringify({ extensions: { path: 'unexpected' } }));
  assert.throws(
    () => installPiExtension(unknown),
    /extensions 字段不是数组/,
  );
  assert.deepEqual(readSettings(unknown.settingsPath), { extensions: { path: 'unexpected' } });
});
