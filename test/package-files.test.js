const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));

test('package file allowlist includes frontend source needed by github npx install', () => {
  const files = new Set(pkg.files || []);

  for (const required of [
    'index.html',
    'src/',
    'vite.config.mjs',
    'tailwind.config.mjs',
    'postcss.config.mjs',
  ]) {
    assert.ok(files.has(required), `${required} must be included so install can build dist from a GitHub package`);
  }
});
