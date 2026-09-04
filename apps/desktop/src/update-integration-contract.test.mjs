import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./integration.mjs', import.meta.url), 'utf8')

test('desktop update notification remains non-blocking and degrades silently', () => {
  assert.match(source, /if \(!Notification\.isSupported\(\)\)[\s\S]*?return false/)
  assert.match(source, /updateNotification\.show\(\)/)
  assert.match(source, /通知或打开浏览器失败同样不能影响主程序/)
})

test('notification click opens explicit update actions instead of auto-installing', () => {
  assert.match(source, /updateNotification\.once\('click', \(\) => \{[\s\S]*?showUpdateActions\(update\)/)
  assert.match(source, /buttons: \['查看版本', '跳过此版本', '稍后'\]/)
  assert.match(source, /shell\.openExternal\(update\.releasePageUrl \?\? update\.downloadUrl\)/)
  assert.doesNotMatch(source, /autoUpdater|quitAndInstall|downloadUpdate/)
})

test('skipping a version is persisted and startup checks are throttled', () => {
  assert.match(source, /patchUpdateState\(\{ skippedVersion: update\.version \}\)/)
  assert.match(source, /shouldCheckForUpdate\(state\.lastCheckedAt\)/)
  assert.match(source, /UPDATE_CHECK_STARTUP_DELAY_MS/)
  assert.match(source, /UPDATE_CHECK_INTERVAL_MS/)
})
