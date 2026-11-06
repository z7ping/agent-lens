import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewEventNodeDto } from '@agent-lens/protocol'
import { projectLiveSnapshotEntries } from './live-task-projection'
import { isRoutineLiveRuntimeNotice, isRoutineReviewRuntimeNotice } from './task-runtime-notice'

const at = '2026-11-06T01:00:00.000Z'
const injected = (rawPayload: Record<string, unknown>): ReviewEventNodeDto => ({
  type: 'event', id: 'pi-injection', kind: 'context.injected', category: 'context',
  at, sourceId: 'pi', label: '扩展上下文', payload: {
    event: 'pi.custom_message', rawPayload,
    provenance: { sourceSignal: 'pi custom message', originType: 'application-injection' },
  }, evidence: [], observationIds: ['obs:injection'], capturedAt: at,
})

test('Pi native hidden extension context folds by source intent, never by MCP text', () => {
  const items = projectLiveSnapshotEntries([
    { type: 'custom_message', id: 'mcp-1', customType: 'mcp', display: false, content: 'MCP: 2 servers enabled' },
    { type: 'custom_message', id: 'ext-2', customType: 'other', display: false, content: 'ready' },
  ])
  assert.equal(items.length, 2)
  assert.ok(items.every(isRoutineLiveRuntimeNotice))
  assert.equal(isRoutineReviewRuntimeNotice(injected({customType: 'mcp', display: true, content: 'MCP: 2 servers enabled'})), true)
})

test('Structured failure/warning stays visible, even for an extension notice', () => {
  const items = projectLiveSnapshotEntries([
    { type: 'custom_message', id: 'error', customType: 'mcp', display: false, details: { severity: 'error' }, content: 'not available' },
    { type: 'custom_message', id: 'warning', customType: 'mcp', display: false, details: { status: 'warning' } },
  ])
  assert.ok(items.every(item => !isRoutineLiveRuntimeNotice(item)))
  assert.equal(isRoutineReviewRuntimeNotice(injected({ customType: 'mcp', display: false, details: { status: 'failed' } })), false)
})

test('Real tools, user messages, permission and unproven injected events do not fold', () => {
  const tools = projectLiveSnapshotEntries([
    { type: 'message', id: 'msg', message: { role: 'user', content: 'MCP: 2 servers enabled' } },
    { type: 'message', id: 'assistant', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', id: 'tool-1', arguments: {} }] } },
  ])
  assert.ok(tools.every(item => !isRoutineLiveRuntimeNotice(item)))
  assert.equal(isRoutineReviewRuntimeNotice({ ...injected({}), kind: 'permission.request' }), false)
  assert.equal(isRoutineReviewRuntimeNotice({ ...injected({}), payload: { event: 'pi.custom_message' } }), false)
  assert.equal(isRoutineReviewRuntimeNotice({ ...injected({}), payload: { event: 'other', provenance: {sourceSignal: 'pi custom message'} } }), false)
})
