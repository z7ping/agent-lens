import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import {
  handleIntegrationDiscoveryRequest,
  type IntegrationDiscoveryController,
} from './integration-discovery-http'

function call(port: number, method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(body) as Record<string, unknown>,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('integration discovery HTTP exposes snapshot and explicit rescan', async () => {
  let rescans = 0
  const state = {
    status: 'complete' as const,
    items: [{
      integrationId: 'pi',
      productId: 'pi',
      displayName: 'Pi',
      presence: 'present' as const,
      executable: '/bin/pi',
    }],
    completedAt: '2026-09-11T12:00:00.000Z',
    generatedAt: '2026-09-11T12:00:00.000Z',
  }
  const controller: IntegrationDiscoveryController = {
    snapshot: () => state,
    rescan: async () => {
      rescans += 1
      return state
    },
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!await handleIntegrationDiscoveryRequest(req, res, url, controller)) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const snapshot = await call(address.port, 'GET', '/api/v1/integrations/discovery')
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.body.status, 'complete')

    const rescan = await call(address.port, 'POST', '/api/v1/integrations/discovery/rescan')
    assert.equal(rescan.status, 200)
    assert.equal(rescans, 1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
