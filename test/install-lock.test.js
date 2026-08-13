const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  acquireInstallLock,
  isInstallLocked,
  removeInstallLock,
} = require('../server/install-lock');

test('安装锁在持有期间可被检测、不可重复获取，并能正常释放', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-install-lock-'));
  const lockFile = path.join(root, 'run', 'install.lock');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  acquireInstallLock(lockFile);
  assert.equal(isInstallLocked(lockFile), true);
  assert.throws(() => acquireInstallLock(lockFile));

  removeInstallLock(lockFile);
  assert.equal(isInstallLocked(lockFile), false);
});
