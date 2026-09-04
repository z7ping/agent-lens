import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./update.ts', import.meta.url), 'utf8')

test('npm update only restarts a running service-owned runtime', () => {
  assert.match(source, /const restartService = service\.active && service\.owner === 'service'/)
  assert.match(source, /runSelf\(\['service', 'stop', '--json'\]\)/)
  assert.match(source, /runSelf\(\['service', 'start', '--json'\]\)/)
})

test('service stop failure cancels install instead of leaving mixed runtime state', () => {
  assert.match(source, /后台服务停止失败，已取消升级/)
  const stopIndex = source.indexOf("runSelf(['service', 'stop', '--json'])")
  const installIndex = source.indexOf("runProcess(npmCommand, npmInstallArgs(update.latestVersion)")
  assert.ok(stopIndex >= 0 && installIndex > stopIndex)
})

test('npm install failure attempts to restore the previous service', () => {
  assert.match(source, /npm 升级失败。[\s\S]*?尝试恢复原 npm 后台服务[\s\S]*?runSelf\(\['service', 'start', '--json'\]\)/)
})

test('desktop-owned runtime is never taken over by npm update', () => {
  assert.match(source, /if \(service\.owner === 'desktop'\) console\.log\('Windows 客户端当前运行时未被 npm 更新命令接管。'\)/)
})
