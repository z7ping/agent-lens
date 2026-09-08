import assert from 'node:assert/strict'
import test from 'node:test'
import { dataRuntimeDiagnosticInternals, logDataRuntimeFailure } from './diagnostics'

test('生产环境对重复 Data Runtime 故障限频并统计被抑制次数', () => {
  const originalLevel = process.env.AGENT_LENS_LOG_LEVEL
  const originalEnvironment = process.env.NODE_ENV
  const originalDevPort = process.env.AGENT_LENS_DEV_API_PORT
  const originalWarn = console.warn
  const calls: unknown[][] = []
  try {
    delete process.env.AGENT_LENS_LOG_LEVEL
    delete process.env.NODE_ENV
    delete process.env.AGENT_LENS_DEV_API_PORT
    dataRuntimeDiagnosticInternals.reset()
    console.warn = (...args: unknown[]) => { calls.push(args) }

    logDataRuntimeFailure('[AgentLens] Data Runtime request failed', { method: 'storage.call' }, 'storage.call')
    logDataRuntimeFailure('[AgentLens] Data Runtime request failed', { method: 'storage.call' }, 'storage.call')

    assert.equal(calls.length, 1)
    assert.equal(dataRuntimeDiagnosticInternals.repeatedDiagnostics.get('storage.call')?.suppressed, 1)
  } finally {
    console.warn = originalWarn
    if (originalLevel === undefined) delete process.env.AGENT_LENS_LOG_LEVEL
    else process.env.AGENT_LENS_LOG_LEVEL = originalLevel
    if (originalEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnvironment
    if (originalDevPort === undefined) delete process.env.AGENT_LENS_DEV_API_PORT
    else process.env.AGENT_LENS_DEV_API_PORT = originalDevPort
    dataRuntimeDiagnosticInternals.reset()
  }
})
