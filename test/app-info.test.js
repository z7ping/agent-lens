const test = require('node:test');
const assert = require('node:assert/strict');

const { getAppInfo } = require('../server/app-info');

test('reads the current app version for UI display', () => {
  const info = getAppInfo();

  assert.equal(info.name, 'agent-trace');
  assert.equal(info.version, '1.9.0');
  assert.equal(info.display_version, 'v1.9.0');
});
