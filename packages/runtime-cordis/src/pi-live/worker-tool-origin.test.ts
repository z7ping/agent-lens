import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const worker = readFileSync(new URL('./worker-entry.mjs', import.meta.url), 'utf8')
const originSource = worker.match(/function registeredPiToolOrigin\(toolName\) \{[\s\S]*?\n\}/)?.[0]
if (!originSource) throw new Error('Pi Worker registration source missing')

const inventorySource = worker.match(/function mcpRegisteredTools\(\) \{[\s\S]*?\n\}/)?.[0]
if (!inventorySource) throw new Error('Pi Worker MCP inventory source missing')

type ToolDefinition = { name: string; sourceInfo?: object; namespace?: object }

function resolveOrigin(tools: ToolDefinition[], name: string, throws = false): Record<string, unknown> {
  const context = {
    session: { getAllTools: () => {
      if (throws) throw new Error('SDK registry temporarily unavailable')
      return tools
    } },
    record: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  }
  const origin = runInNewContext(`${originSource}\nregisteredPiToolOrigin`, context) as (value: string) => Record<string, unknown>
  return origin(name)
}

test('Pi Live accepts only unique native builtin:mcp registration, not names or aliases', () => {
  const registered = {
    name: 'dbx_execute_query',
    sourceInfo: { path: 'builtin:mcp' },
    namespace: { name: 'mcp__dbx', aliases: ['a-different-alias'] },
  }
  const origin = resolveOrigin([registered], 'dbx_execute_query')
  assert.equal(origin.toolSourceType, 'mcp')
  assert.equal(origin.mcpServerId, 'dbx')
  assert.equal((origin.toolRegistration as Record<string, unknown>).registry, 'pi.AgentSession.getAllTools')

  // A third-party Pi MCP adapter does not expose the server identity here.
  assert.equal(resolveOrigin([{ ...registered, sourceInfo: { path: 'extensions/pi-mcp-adapter' } }], 'dbx_execute_query').toolSourceType, undefined)
  assert.equal(resolveOrigin([registered], 'missing').toolSourceType, undefined)
  assert.equal(resolveOrigin([{ ...registered, namespace: { name: 'mcp__' } }], 'dbx_execute_query').toolSourceType, undefined)
})

test('Pi Live source attribution is unknown for same-name collisions, removal, or registry failures', () => {
  const first = {
    name: 'same',
    sourceInfo: { path: 'builtin:mcp' },
    namespace: { name: 'mcp__first' },
  }
  const second = { ...first, namespace: { name: 'mcp__second' } }
  assert.equal(resolveOrigin([first, second], 'same').toolSourceType, undefined)
  assert.equal(resolveOrigin([], 'same').toolSourceType, undefined)
  assert.equal(resolveOrigin([first], 'same', true).toolSourceType, undefined)
})

test('Pi Worker MCP tool inventory excludes third-party, hidden and unverified registrations', () => {
  const tools = [
    { name: 'mcp__docs__search', description: 'Search', exposure: 'codemode',
      sourceInfo: { path: 'builtin:mcp' }, namespace: { name: 'mcp__docs' } },
    { name: 'mcp__docs__withdrawn', exposure: 'hidden',
      sourceInfo: { path: 'builtin:mcp' }, namespace: { name: 'mcp__docs' } },
    { name: 'mcp__docs__fake', exposure: 'direct',
      sourceInfo: { path: '/user/mcp-adapter' }, namespace: { name: 'mcp__docs' } },
    { name: 'mcp__tools__strange', exposure: 'direct',
      sourceInfo: { path: 'builtin:mcp' }, namespace: { name: 'other' } },
  ]
  const context = {
    session: { getAllTools: () => tools },
    slashCommands: () => [{ name: 'mcp', mcpManager: true }],
    record: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  }
  const read = runInNewContext(`${inventorySource}\nmcpRegisteredTools`, context) as () => Array<{ serverId: string; name: string; exposure: string }>
  assert.deepEqual(JSON.parse(JSON.stringify(read())), [
    { serverId: 'docs', name: 'mcp__docs__search', description: 'Search', exposure: 'codemode' },
  ])
  const untrusted = runInNewContext(`${inventorySource}\nmcpRegisteredTools`, {
    ...context, slashCommands: () => [{ name: 'mcp', mcpManager: false }],
  }) as () => unknown[]
  assert.equal(untrusted().length, 0)
})
