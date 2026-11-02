import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { handleHermesLiveSetupRequest, type HermesLiveSetupController } from './hermes-live-setup-http'
import { statusCodeForError, writeJson } from './http-utils'

async function withServer(
  controller: HermesLiveSetupController | undefined,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!await handleHermesLiveSetupRequest(req, res, url, controller)) writeJson(res, 404, {})
    } catch (error) {
      writeJson(res, statusCodeForError(error), { error: error instanceof Error ? error.message : String(error) })
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try { await run(address.port) } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()))
  }
}

function post(port: number, body: unknown, origin?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = request({
      host: '127.0.0.1', port, path: '/api/v1/live/hermes/initialize', method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        data: JSON.parse(text) as Record<string, unknown>,
      }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('Hermes initialization requires explicit opt-in and disallows cross-origin writes', async () => {
  let calls = 0
  await withServer(async () => { calls++; return { status: 'needs-gateway' } }, async port => {
    assert.equal((await post(port, {})).status, 400)
    assert.equal((await post(port, { confirm: true }, 'http://evil.example')).status, 403)
    assert.equal(calls, 0)
    const accepted = await post(port, { confirm: true })
    assert.equal(accepted.status, 200)
    assert.deepEqual(accepted.data, { status: 'needs-gateway' })
    assert.equal(calls, 1)
  })
})

test('Hermes setup endpoint is unavailable without a granted Live adapter', async () => {
  await withServer(undefined, async port => {
    const result = await post(port, { confirm: true })
    assert.equal(result.status, 503)
    assert.equal(result.data.error, 'hermes_setup_not_authorized')
  })
})
