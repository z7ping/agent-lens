const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const hasWindowsRunner = fs.existsSync(path.join(__dirname, '..', 'server', 'hooks', 'windows-hook-runner.exe'));

test('cli help documents every command, option, and platform mode', () => {
  const root = path.join(__dirname, '..');
  const cli = path.join(root, 'server', 'cli.js');
  const help = execFileSync(process.execPath, [cli, '--help'], {
    cwd: root,
    encoding: 'utf-8',
  });

  for (const expected of [
    'install',
    'start [port] [options]',
    'stop',
    'status',
    'service <subcommand>',
    'pi-extension <subcommand>',
    'pi-extension status',
    'pi-extension install',
    'pi-extension upgrade',
    'pi-extension uninstall',
    'package [--output <dir>]',
    'uninstall',
    'help, --help, -h',
    '--daemon, -d',
    '--port <port>',
    '--open',
    '--output <dir>',
    'Linux:  systemd user service',
    'macOS:  launchd agent',
    'Windows: 当前用户启动目录',
    '支持全部 service 子命令',
    'status 当前固定检查默认端口 56789',
  ]) {
    assert.match(help, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('cli package command creates an npm-compatible archive with current runtime files only', { timeout: 30000 }, () => {
  const root = path.join(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-package-test-'));
  const cli = path.join(root, 'server', 'cli.js');

  execFileSync(process.execPath, [cli, 'package', '--output', tmp], {
    cwd: root,
    encoding: 'utf-8',
  });

  const archives = fs.readdirSync(tmp).filter(name => /^z7ping-agent-lens-.+\.tgz$/.test(name));
  assert.equal(archives.length, 1);
  const archivePath = path.join(tmp, archives[0]);
  const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' });

  const requiredFiles = [
    'server/server.js',
    'server/cli.js',
    'server/routes.js',
    'server/overview.js',
    'server/pi-extension-manager.js',
    'server/sources-status.js',
    'server/app-info.js',
    'server/install-layout.js',
    'server/install-lock.js',
    'server/hooks/build-windows-hook-runner.ps1',
    'server/hooks/pi-runtime-extension.js',
    'server/hooks/windows-hook-runner.cs',
    'server/importers/index.js',
    'dist/index.html',
    'package.json',
    'README.md',
    'CHANGELOG.md',
  ];
  if (hasWindowsRunner) requiredFiles.push('server/hooks/windows-hook-runner.exe');

  for (const required of requiredFiles) {
    assert.match(listing, new RegExp(`package/${required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }

  for (const forbidden of [
    'projects.json',
    '.agent-lens/',
    'states/',
    'agent-lens.db',
  ]) {
    assert.doesNotMatch(listing, new RegExp(`package/(?:server/)?${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
});

test('cli installs production dependencies into the separated app directory', () => {
  const root = path.join(__dirname, '..');
  const cliSource = fs.readFileSync(path.join(root, 'server', 'cli.js'), 'utf8');

  assert.match(cliSource, /npm install --omit=dev/);
  assert.match(cliSource, /--registry=https:\/\/registry\.npmjs\.org\//);
  assert.match(cliSource, /--package-lock=false/);
  assert.match(cliSource, /INSTALL_RUNTIME_PATHS\.binDir/);
  assert.match(cliSource, /activateStagedApplication/);
  assert.match(cliSource, /rollbackInstalledApplication/);
  assert.match(cliSource, /cleanupFlatApplication/);
  assert.match(cliSource, /spawn\(process\.execPath, \[installedServer, String\(port\), '--daemon'\]/);
  assert.match(cliSource, /syncInstalledHooks\('上一版 Hooks 配置恢复失败'\)/);
  assert.doesNotMatch(cliSource, /\[installedCli, 'start', '--daemon'/);
});
