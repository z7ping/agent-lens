import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isLegacyAppInfo,
  isLegacyStartupContent,
  legacyWindowsPaths,
  looksLikeLegacyProcess,
} from './legacy-windows-migration.mjs'

test('legacyWindowsPaths matches the 0.x Windows installed layout', () => {
  const paths = legacyWindowsPaths({
    homeDir: 'C:\\Users\\tester',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
  })

  assert.equal(paths.legacyInstallDir, 'C:\\Users\\tester\\.agent-lens\\app')
  assert.equal(paths.legacyPidFile, 'C:\\Users\\tester\\.agent-lens\\run\\server.pid')
  assert.equal(
    paths.legacyStartupFile,
    'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\AgentLens.vbs',
  )
})

test('isLegacyAppInfo only accepts AgentLens 0.x app-info responses', () => {
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '0.7.0' }), true)
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '0.6.2' }), true)
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '1.0.0-alpha.1' }), false)
  assert.equal(isLegacyAppInfo({ name: 'another-service', version: '0.7.0' }), false)
  assert.equal(isLegacyAppInfo(null), false)
})

test('looksLikeLegacyProcess requires the known 0.x install directory and server entry', () => {
  const legacyInstallDir = 'C:\\Users\\tester\\.agent-lens\\app'
  assert.equal(looksLikeLegacyProcess({
    processId: 1234,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.agent-lens\\app\\server.js" 56789 --daemon',
  }, legacyInstallDir), true)

  assert.equal(looksLikeLegacyProcess({
    processId: 5678,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "D:\\other\\server.js" 56789',
  }, legacyInstallDir), false)

  assert.equal(looksLikeLegacyProcess({
    processId: 5679,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.agent-lens\\app\\worker.js"',
  }, legacyInstallDir), false)
})

test('isLegacyStartupContent only removes the AgentLens 0.x VBS startup entry', () => {
  const legacyInstallDir = 'C:\\Users\\tester\\.agent-lens\\app'
  const owned = [
    'Set objShell = CreateObject("WScript.Shell")',
    'objShell.Run "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\tester\\.agent-lens\\app\\server.js\\" 56789 --daemon", 0, False',
  ].join('\r\n')

  assert.equal(isLegacyStartupContent(owned, legacyInstallDir), true)
  assert.equal(isLegacyStartupContent('objShell.Run "C:\\Tools\\other-server.js"', legacyInstallDir), false)
})
