import assert from 'node:assert/strict'
import test from 'node:test'
import { runPluginCommand, pluginCommandInternals } from './plugin-command'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function managementPayload() {
  return {
    items: [{
      integrationId: 'pi',
      productId: 'pi',
      displayName: 'Pi',
      tool: {
        integrationId: 'pi',
        productId: 'pi',
        displayName: 'Pi',
        presence: 'present',
        executable: '/usr/bin/pi',
      },
      packageState: {
        integrationId: 'pi',
        installed: true,
        installedVersion: '1.0.0-alpha.5',
        availableVersion: '1.0.0-alpha.5',
        compatibility: 'compatible',
        integrity: 'verified',
        restartRequired: false,
      },
      enabled: {
        configured: true,
        effective: true,
        editable: true,
        managedBy: 'file',
        restartRequired: false,
      },
      availability: 'available',
      capabilities: [{
        capability: 'source',
        availability: 'available',
      }],
      isNew: false,
      displayOrder: 0,
    }],
    discovery: {
      status: 'complete',
      generatedAt: '2026-09-12T00:00:00.000Z',
    },
    preferences: {
      onboarding: { completed: true },
      displayOrder: ['pi'],
      displayOrderConfigured: true,
      acknowledgedIntegrationIds: ['pi'],
      updatedAt: '2026-09-12T00:00:00.000Z',
    },
    meta: {
      protocolVersion: '1.0',
      generatedAt: '2026-09-12T00:00:00.000Z',
    },
  }
}

test('plugin list reads the unified Integration management projection', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const output: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
    })
    return jsonResponse(managementPayload())
  }) as typeof fetch

  const code = await runPluginCommand('list', [], false, {
    apiUrl: path => `http://127.0.0.1:56789${path}`,
    fetchImpl,
    print: line => output.push(line),
  })

  assert.equal(code, 0)
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:56789/api/v1/integrations',
    method: 'GET',
  }])
  assert.match(output[0] ?? '', /Pi \(pi\).*已安装 1\.0\.0-alpha\.5.*已开启.*可用.*已发现/)
})

test('plugin status returns one unified Integration item in JSON mode', async () => {
  const output: string[] = []
  const fetchImpl = (async () => jsonResponse(managementPayload())) as typeof fetch

  const code = await runPluginCommand('status', ['PI'], true, {
    apiUrl: path => `http://agent-lens.test${path}`,
    fetchImpl,
    print: line => output.push(line),
  })

  assert.equal(code, 0)
  const result = JSON.parse(output.join('\n')) as { item: { integrationId: string } }
  assert.equal(result.item.integrationId, 'pi')
})

test('plugin install/remove/update reuse Package Lifecycle HTTP methods and propagate operation failure as exit code', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url=String(input)
    const method=String(init?.method ?? 'GET')
    requests.push({ url, method })
    const kind = url.endsWith('/install')
      ? 'install'
      : url.endsWith('/update')
        ? 'update'
        : 'remove'
    const failed = kind === 'update'
    return jsonResponse({
      operation: {
        operationId: `operation-${kind}`,
        integrationId: 'pi',
        kind,
        status: failed ? 'failed' : 'completed',
        startedAt: '2026-09-12T00:00:00.000Z',
        completedAt: '2026-09-12T00:00:01.000Z',
        ...(failed ? { errorCode: 'incompatible', message: 'API incompatible' } : {}),
      },
      state: {
        integrationId: 'pi',
        installed: kind !== 'remove',
        installedVersion: kind !== 'remove' ? '1.0.0-alpha.5' : undefined,
        compatibility: 'compatible',
        integrity: 'verified',
        restartRequired: true,
      },
      meta: { protocolVersion: '1.0', generatedAt: '2026-09-12T00:00:01.000Z' },
    })
  }) as typeof fetch

  const options = {
    apiUrl: (path: string) => `http://agent-lens.test${path}`,
    fetchImpl,
    print: () => undefined,
  }

  assert.equal(await runPluginCommand('install', ['pi'], false, options), 0)
  assert.equal(await runPluginCommand('update', ['pi'], false, options), 1)
  assert.equal(await runPluginCommand('remove', ['pi'], false, options), 0)

  assert.deepEqual(requests, [
    { url: 'http://agent-lens.test/api/v1/integrations/pi/install', method: 'POST' },
    { url: 'http://agent-lens.test/api/v1/integrations/pi/update', method: 'POST' },
    { url: 'http://agent-lens.test/api/v1/integrations/pi', method: 'DELETE' },
  ])
})

test('Package Lifecycle unavailable returns a clear CLI error instead of falling back to direct disk writes', async () => {
  const fetchImpl = (async () => jsonResponse({
    error: 'integration_package_lifecycle_unavailable',
  }, 503)) as typeof fetch

  await assert.rejects(
    () => runPluginCommand('install', ['pi'], false, {
      apiUrl: path => `http://agent-lens.test${path}`,
      fetchImpl,
      print: () => undefined,
    }),
    /Package Lifecycle 当前不可用/,
  )
})

test('plugin ID validation rejects paths and keeps normalization stable', () => {
  assert.equal(pluginCommandInternals.normalizePluginId(' Claude-Code '), 'claude-code')
  assert.throws(() => pluginCommandInternals.normalizePluginId('../pi'), /只能包含/)
  assert.throws(() => pluginCommandInternals.normalizePluginId(undefined), /请提供 Integration ID/)
})
