import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAgentWorkSchedule } from './agent-work-schedule-label'

const format = (unit: 's' | 'm' | 'h' | 'd', count: number) => `${count} ${unit}`
test('Hermes native every 60m interval displays a localized duration without changing its value', () => {
  assert.equal(formatAgentWorkSchedule('every 60m', format), '60 m')
  assert.equal(formatAgentWorkSchedule('every 1h', format), '1 h')
  assert.equal(formatAgentWorkSchedule('every 2d', format), '2 d')
  assert.equal(formatAgentWorkSchedule('every 20s', format), '20 s')
})
test('Cron, malformed and too-large intervals retain native schedule, never invent semantics', () => {
  for (const raw of ['*/5 * * * *', 'every 0m', 'every xh', 'every 99999999999999999999m', 'once 1h', '', 'at 2026-11-05']) {
    assert.equal(formatAgentWorkSchedule(raw, format), raw)
  }
})
