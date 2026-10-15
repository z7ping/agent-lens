import assert from 'node:assert/strict'
import test from 'node:test'
import type { TimelineItemDto } from './timeline'
import { ToolRegistrationIndex } from './tool-registration'

const start = Date.parse('2026-10-15T00:00:00.000Z')

function item(
  kind: 'tool.registration' | 'tool.call',
  timeMs: number,
  payload: Record<string, unknown>,
  options: { installationId?: string; sourceId?: string; trustworthy?: boolean } = {},
): TimelineItemDto {
  const time = new Date(start + timeMs).toISOString()
  return {
    id: `${kind}:${timeMs}:${options.installationId ?? 'installation-A'}`,
    kind,
    installationId: options.installationId ?? 'installation-A',
    sourceId: options.sourceId ?? 'agent-A',
    productId: 'agent-A', hostId: 'host',
    logicalSessionId: 'session-1', sourceSessionId: 'source-session-1',
    capturedAt: time, effectiveAt: time,
    payload: payload as TimelineItemDto['payload'],
    evidence: options.trustworthy === false ? [{
      id: `untrusted:${timeMs}`, captureMethod: 'static-scan',
      derivation: 'inferred', confidence: 'low', capturedAt: time,
    }] : [{
      id: `native:${timeMs}`, captureMethod: 'runtime-hook',
      derivation: 'observed', confidence: 'exact', capturedAt: time,
    }],
  }
}

function registered(
  timeMs: number,
  registrationId: string,
  tool: string,
  scope = 'runtime-A',
  options: { installationId?: string; server?: string; profileId?: string; sourceId?: string; trustworthy?: boolean } = {},
): TimelineItemDto {
  return item('tool.registration', timeMs, {
    registrationId, nativeToolName: tool, runtimeId: scope,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    action: 'registered', toolSourceType: 'mcp', mcpServerId: options.server ?? 'server-A',
  }, options)
}

function removed(timeMs: number, registrationId: string, tool: string, scope = 'runtime-A') {
  return item('tool.registration', timeMs, { registrationId, nativeToolName: tool, runtimeId: scope, action: 'removed' })
}

function call(timeMs: number, tool: string, scope = 'runtime-A', options: { installationId?: string; sourceId?: string; profileId?: string } = {}) {
  return item('tool.call', timeMs, {
    nativeToolName: tool, runtimeId: scope,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    callId: `call-${timeMs}`,
  }, options)
}

test('同一安装/运行/配置的原生注册事实才能为工具调用归因', () => {
  const registration = registered(1, 'reg-1', 'query_data')
  const index = new ToolRegistrationIndex([
    registration,
    registered(2, 'reg-2', 'query_data', 'runtime-B', { server: 'server-B' }),
    registered(3, 'reg-3', 'query_data', 'runtime-A', { installationId: 'installation-B', server: 'server-C' }),
    registered(4, 'reg-4', 'query_data', 'runtime-A', { profileId: 'profile-B', server: 'server-D' }),
    registered(5, 'reg-5', 'query_data', 'runtime-A', { sourceId: 'agent-B', server: 'server-E' }),
  ])
  assert.deepEqual(index.resolve(call(10, 'query_data')), {
    toolSourceType: 'mcp', mcpServerId: 'server-A',
    registrationObservationId: registration.id,
    evidence: registration.evidence,
  })
  assert.equal(index.resolve(call(10, 'query_data', 'unrelated-runtime')), undefined)
  assert.equal(index.resolve(call(10, 'query_data', 'runtime-A', { profileId: 'unrelated-profile' })), undefined)
})

test('同一名称发生注销或重注册时按时序生效，过去的会话不被回写', () => {
  const index = new ToolRegistrationIndex([
    registered(1, 'reg-1', 'execute'),
    removed(10, 'reg-1', 'execute'),
    registered(20, 'reg-2', 'execute', 'runtime-A', { server: 'server-B' }),
  ])
  assert.equal(index.resolve(call(0, 'execute')), undefined)
  assert.equal(index.resolve(call(5, 'execute'))?.mcpServerId, 'server-A')
  assert.equal(index.resolve(call(15, 'execute')), undefined)
  assert.equal(index.resolve(call(25, 'execute'))?.mcpServerId, 'server-B')
  assert.equal(index.resolve(call(20, 'execute')), undefined, '同一时间戳顺序未知，不得认领')
})

test('同运行上下文多个活跃定义冲突时必须退化未知，不按名称或前缀猜', () => {
  const index = new ToolRegistrationIndex([
    registered(1, 'one', 'mcp__shared__tool'),
    registered(2, 'two', 'mcp__shared__tool', 'runtime-A', { server: 'other-server' }),
  ])
  assert.equal(index.resolve(call(5, 'mcp__shared__tool')), undefined)
  assert.equal(new ToolRegistrationIndex([]).resolve(call(5, 'mcp__shared__tool')), undefined)
})

test('低可信、缺字段与可能漏掉的注销均不能继承上一条归属', () => {
  const index = new ToolRegistrationIndex([
    registered(1, 'one', 'read'),
    item('tool.registration', 3, { registrationId: 'one', nativeToolName: 'read', runtimeId: 'runtime-A', action: 'removed' }, { trustworthy: false }),
  ])
  assert.equal(index.resolve(call(2, 'read'))?.mcpServerId, 'server-A')
  assert.equal(index.resolve(call(4, 'read')), undefined)
  assert.equal(new ToolRegistrationIndex([registered(1, 'one', 'read', 'runtime-A', { trustworthy: false })]).resolve(call(4, 'read')), undefined)
  const missingRuntimeCall = item('tool.call', 4, { nativeToolName: 'read' })
  assert.equal(index.resolve(missingRuntimeCall), undefined)
})

test('不完整分页的注册事实窗口不可补全历史归属', () => {
  // The caller must reject a timeline page with hasMore=true instead of
  // treating an incomplete subset as a complete registry.
  assert.equal(new ToolRegistrationIndex([]).resolve(call(10, 'list_files')), undefined)
})
