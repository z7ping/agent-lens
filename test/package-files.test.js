const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('package file allowlist excludes runtime state and local project data', () => {
  const files = new Set(pkg.files || []);

  assert.equal(files.has('server/'), false, 'server/ is too broad and can include runtime states or local project data');
  for (const forbidden of [
    'server/projects.json',
    'server/states/',
    '.agent-lens/',
    'logs/',
    'states/',
    'agent-lens.db',
    'dist/',
  ]) {
    assert.equal(files.has(forbidden), false, `${forbidden} must not be included in package files`);
  }
});

test('published README does not reference documentation assets missing from the npm package', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  for (const missingTarget of [
    'docs/static/',
    'CONTRIBUTING.md)',
    'ARCHITECTURE.md)',
    'SECURITY.md)',
  ]) {
    assert.equal(readme.includes(`](${missingTarget}`), false, `${missingTarget} must use an absolute GitHub URL`);
  }
});

test('repository and publish configuration use the official npm registry', () => {
  const npmrc = fs.readFileSync(path.join(__dirname, '..', '.npmrc'), 'utf8');
  const lockfile = fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8');

  assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
  assert.match(npmrc, /^replace-registry-host=always$/m);
  assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org/');
  assert.doesNotMatch(lockfile, /registry\.npmmirror\.com/);
});
