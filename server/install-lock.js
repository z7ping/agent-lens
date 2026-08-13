const fs = require('fs');
const path = require('path');

const INCOMPLETE_LOCK_GRACE_MS = 5 * 60 * 1000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readInstallLock(lockFile) {
  try {
    const stat = fs.statSync(lockFile);
    const value = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const pid = Number(value?.pid);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
    };
  } catch (_) {
    try {
      const stat = fs.statSync(lockFile);
      return { pid: null, ageMs: Math.max(0, Date.now() - stat.mtimeMs) };
    } catch (_) {
      return null;
    }
  }
}

function removeInstallLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isInstallLocked(lockFile) {
  const lock = readInstallLock(lockFile);
  if (!lock) return false;
  if (lock.pid && isProcessAlive(lock.pid)) return true;
  if (!lock.pid && lock.ageMs < INCOMPLETE_LOCK_GRACE_MS) return true;

  try { removeInstallLock(lockFile); } catch (_) {}
  return false;
}

function acquireInstallLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isInstallLocked(lockFile)) {
        const owner = readInstallLock(lockFile)?.pid;
        throw new Error(owner ? `已有安装进程正在运行 (PID: ${owner})` : '已有安装进程正在运行');
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  throw new Error('无法获取安装锁');
}

module.exports = {
  acquireInstallLock,
  isInstallLocked,
  removeInstallLock,
};
