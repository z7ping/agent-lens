const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const fs = require('fs');

const { getAppInfo, getPackageJsonPath } = require('../server/app-info');

test('reads the current app version for UI display', () => {
  const info = getAppInfo();

  assert.equal(info.name, 'agent-trace');
  assert.equal(info.version, '1.9.1');
  assert.equal(info.display_version, 'v1.9.1');
  assert.equal(info.subtitle, '多 Agent 调用链路观测与复盘工具');
  assert.equal(info.repository_url, 'https://github.com/z7ping/agent-trace');
  assert.ok(info.changelog.current_version.includes('1.9.1'));
  assert.ok(info.changelog.items.length > 0);
});

test('resolves package.json from installed flat layout', () => {
  const baseDir = path.join(__dirname, '..');

  assert.equal(getPackageJsonPath(baseDir), path.join(baseDir, 'package.json'));
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
