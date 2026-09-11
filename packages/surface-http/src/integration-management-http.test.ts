import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import {
  handleIntegrationManagementRequest,
  integrationManagementHttpInternals,
  type IntegrationManagementController,
} from './integration-management-http'

function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : undefined,
    }, response => {
      let value = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { value += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: value ? JSON.parse(value) as Record<string, unknown> : {},
      }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('management preference parser rejects reopening completed onboarding', () => {
  assert.throws(
    () => integrationManagementHttpInternals.preferencePayload({ onboardingCompleted: false }),
    /only transition to true/,
  )
})

test('Integration management route exposes unified state without inventing Installed/package state', async () => {
  const preferences = {
    onboarding: { completed: false },
    displayOrder: ['pi', 'codex', 'claude-code', 'hermes', 'opencode'],
    displayOrderConfigured: false,
    acknowledgedIntegrationIds: [],
    updatedAt: new Date(0).toISOString(),
  }
  const controller: IntegrationManagementController = {
    query: async () => ({
      items: [{
        integrationId: 'pi',
        productId: 'pi',
        displayName: 'Pi',
        enabled: {
          configured: true,
          effective: true,
          editable: true,
          managedBy: 'file',
          restartRequired: false,
        },
        availability: 'available',
        capabilities: [],
        isNew: false,
        displayOrder: 0,
      }],
      discovery: {
        status: 'complete',
        generatedAt: '2026-09-11T12:00:00.000Z',
      },
      preferences,
    }),
    preferences: () => preferences,
    updatePreferences: async () => preferences,
    enabled: () => ({
      configured: true,
      effective: true,
      editable: true,
      managedBy: 'file',
      restartRequired: false,
    }),
    setEnabled: async (_id, enabled) => ({
      configured: enabled,
      effective: true,
      editable: true,
      managedBy: 'file',
      restartRequired: !enabled,
    }),
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!await handleIntegrationManagementRequest(req, res, url, controller)) {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const response = await call(address.port, 'GET', '/api/v1/integrations')
    assert.equal(response.status, 200)
    const items = response.body.items as Array<Record<string, unknown>>
    assert.equal(items.length, 1)
    assert.equal('package' in items[0]!, false)
    assert.equal('installed' in items[0]!, false)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    )
  }
})
