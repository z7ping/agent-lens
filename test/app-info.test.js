const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');

const { getAppInfo, getPackageJsonPath } = require('../server/app-info');

test('reads the current app version for UI display', () => {
  const info = getAppInfo();

  assert.equal(info.name, 'agent-trace');
  assert.equal(info.version, '1.9.1');
  assert.equal(info.display_version, 'v1.9.1');
});

test('resolves package.json from installed flat layout', () => {
  const baseDir = path.join(__dirname, '..');

  assert.equal(getPackageJsonPath(baseDir), path.join(baseDir, 'package.json'));
});
