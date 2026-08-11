const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const fs = require('fs');

const { getAppInfo, getPackageJsonPath } = require('../server/app-info');
const { DB_PATH } = require('../server/agent-lens-db');
const packageJson = require('../package.json');

test('reads the current app version for UI display', () => {
  const info = getAppInfo();

  assert.equal(info.name, '@z7ping/agent-lens');
  assert.equal(info.version, packageJson.version);
  assert.equal(info.display_version, `v${packageJson.version}`);
  assert.equal(info.subtitle, '多 Agent 调用链路观测与复盘工具');
  assert.equal(info.repository_url, 'https://github.com/z7ping/agent-lens');
});

test('resolves package.json from installed flat layout', () => {
  const baseDir = path.join(__dirname, '..');

  assert.equal(getPackageJsonPath(baseDir), path.join(baseDir, 'package.json'));
});

test('uses AgentLens named SQLite database file', () => {
  assert.equal(path.basename(DB_PATH), 'agent-lens.db');
});

test('keeps explicit UI font sizes at 12px or larger', () => {
  const files = [
    path.join(__dirname, '..', 'index.html'),
    path.join(__dirname, '..', 'src', 'style.css'),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    assert.equal(/text-\[(?:10|11)px\]/.test(content), false, `${file} 不应使用小于 12px 的显式字号`);
  }
});

test('keeps changelog modal hidden state stronger than modal flex layout', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf-8');

  assert.match(content, /\.modal-backdrop\.hidden\s*\{[^}]*display:\s*none;[^}]*\}/s);
});
