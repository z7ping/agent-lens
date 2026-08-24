import type { ServerResponse } from 'node:http'
import type { LiveUpdateEventDto } from '@agent-lens/protocol'

interface Client {
  response: ServerResponse
  heartbeat: NodeJS.Timeout
}

export class HttpEventHub {
  private readonly clients = new Set<Client>()
  private closed = false

  connect(response: ServerResponse): void {
    if (this.closed) {
      response.statusCode = 503
      response.end()
      return
    }

    response.statusCode = 200
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('cache-control', 'no-cache, no-transform')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders?.()

    let client!: Client
    client = {
      response,
      heartbeat: setInterval(() => this.write(client, ': heartbeat\n\n'), 15_000),
    }
    this.clients.add(client)
    this.write(client, 'retry: 1500\nevent: ready\ndata: {}\n\n')

    response.once('close', () => this.remove(client))
    response.once('error', () => this.remove(client))
  }

  publish(event: LiveUpdateEventDto): void {
    if (this.closed) return
    const payload = `event: observation\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of [...this.clients]) this.write(client, payload)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const client of [...this.clients]) {
      this.remove(client)
      if (!client.response.destroyed) client.response.end()
    }
  }

  private write(client: Client, payload: string): void {
    if (client.response.destroyed || client.response.writableEnded) {
      this.remove(client)
      return
    }
    try {
      client.response.write(payload)
    } catch {
      this.remove(client)
    }
  }

  private remove(client: Client): void {
    clearInterval(client.heartbeat)
    this.clients.delete(client)
  }
}
