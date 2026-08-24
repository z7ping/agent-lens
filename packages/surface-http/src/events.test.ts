import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import test from 'node:test'
import type { LiveUpdateEventDto } from '@agent-lens/protocol'
import { HttpEventHub } from './events'

class FakeResponse extends EventEmitter {
  statusCode = 0
  destroyed = false
  writableEnded = false
  headers = new Map<string, string>()
  writes: string[] = []

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  flushHeaders(): void {}

  write(payload: string): boolean {
    if (this.destroyed || this.writableEnded) throw new Error('closed')
    this.writes.push(payload)
    return true
  }

  end(): void {
    this.writableEnded = true
  }
}

function asServerResponse(response: FakeResponse): ServerResponse {
  return response as unknown as ServerResponse
}

test('SSE 连接下发重连间隔并发布 observation 事件', () => {
  const hub = new HttpEventHub()
  const response = new FakeResponse()
  hub.connect(asServerResponse(response))

  assert.equal(response.statusCode, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.match(response.writes[0] ?? '', /retry: 1500/)
  assert.match(response.writes[0] ?? '', /event: ready/)

  const event: LiveUpdateEventDto = {
    type: 'observation.committed',
    observationId: 'obs-1',
    logicalSessionId: 'session-1',
    affected: ['review'],
    emittedAt: '2026-08-24T08:00:00.000Z',
  }
  hub.publish(event)

  assert.match(response.writes[1] ?? '', /event: observation/)
  assert.match(response.writes[1] ?? '', /"observationId":"obs-1"/)
  hub.close()
  assert.equal(response.writableEnded, true)
})

test('SSE 客户端关闭后不再接收后续事件', () => {
  const hub = new HttpEventHub()
  const response = new FakeResponse()
  hub.connect(asServerResponse(response))
  const before = response.writes.length

  response.destroyed = true
  response.emit('close')
  hub.publish({
    type: 'agent.changed',
    sourceId: 'codex',
    affected: ['agents'],
    emittedAt: '2026-08-24T08:00:00.000Z',
  })

  assert.equal(response.writes.length, before)
  hub.close()
})
