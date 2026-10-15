import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLiveEventDto } from '@agent-lens/protocol'
import { toolVisualKind } from '../components/ToolKindIcon'
import { reduceLiveTaskEvent } from './live-task-projection'

test('MCP evidence has priority over misleading keywords in native tool names', () => {
  assert.equal(toolVisualKind('dbx_execute_query'), 'tool')
  assert.equal(toolVisualKind('dbx_execute_query', { sourceType: 'mcp', mcpServerId: 'dbx' }), 'mcp')
  assert.equal(toolVisualKind('dbx_execute_query', { mcpServerId: 'dbx' }), 'mcp')
  assert.equal(toolVisualKind('mcp__dbx__execute_query'), 'tool')
  assert.equal(toolVisualKind('mcp__dbx__execute_query', { sourceType: 'mcp', mcpServerId: 'dbx' }), 'mcp')
  assert.equal(toolVisualKind('exec_command'), 'shell')
  assert.equal(toolVisualKind('bash'), 'shell')
  assert.equal(toolVisualKind('search_files'), 'search')
  assert.equal(toolVisualKind('my_execute_query'), 'tool')
})

test('MCP origin metadata survives a normalized Live start and later output/end events', () => {
  const normalized = parseLiveEventDto({
    type: 'tool.start', name: 'dbx_execute_query', callId: 'call-1',
    toolSourceType: 'mcp', mcpServerId: 'dbx', parentToolCallId: 'codemode-1', inputPreview: '{"sql":"SELECT 1"}',
  })
  assert.ok(normalized?.type === 'tool.start')
  assert.equal(normalized.toolSourceType, 'mcp')
  assert.equal(normalized.mcpServerId, 'dbx')
  const envelope = (sequence: number, event: NonNullable<ReturnType<typeof parseLiveEventDto>>) => ({
    runtimeSessionId: 'runtime-1',
    sequence,
    receivedAt: '2026-10-14T00:00:00.000Z',
    event: {},
    normalizedEvent: event,
  })
  let items = reduceLiveTaskEvent([], envelope(1, normalized))
  items = reduceLiveTaskEvent(items, envelope(2, { type: 'tool.output', callId: 'call-1', output: '| col | val |' }))
  items = reduceLiveTaskEvent(items, envelope(3, { type: 'tool.end', callId: 'call-1', parentToolCallId: 'codemode-1', status: 'success' }))
  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.toolSourceType, 'mcp')
  assert.equal(tool.mcpServerId, 'dbx')
  assert.equal(tool.parentToolCallId, 'codemode-1')
})

test('unknown tool names are not turned into Shell without trusted evidence', () => {
  assert.equal(toolVisualKind('execute_query'), 'tool')
  assert.equal(toolVisualKind('shell_executable'), 'shell')
  assert.equal(toolVisualKind('dbx_execute_query', { sourceType: 'unknown' }), 'tool')
})
