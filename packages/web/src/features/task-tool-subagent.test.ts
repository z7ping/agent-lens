import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isPiSubagentTool, piSubagentResult, piSubagentSummary, piSubagentToolDetails, piSubagentTranscriptMessage } from './task-tool-subagent'
import { TaskToolRow } from './TaskToolRow'

test('official Pi subagent modes read results without inventing a child session', () => {
  for (const mode of ['single', 'parallel', 'chain'] as const) {
    const original = [{ agent: 'scout', status: 'completed', messages: [] },
      { agent: 'worker', status: 'failed', errorMessage: 'exit 1', messages: [] }]
    const parsed = piSubagentToolDetails('subagent', { mode, results: original })
    assert.equal(parsed?.mode, mode)
    assert.equal(parsed?.results, original)
    assert.equal(Object.hasOwn(parsed!, 'childSessionId'), false)
  }
  assert.deepEqual(piSubagentToolDetails('subagent', { mode: 'single', results: [] }),
    { mode: 'single', results: [] })
})

test('subagent identity is explicit even before a result, without mislabeling MCP tools', () => {
  assert.equal(isPiSubagentTool('subagent'), true)
  assert.equal(isPiSubagentTool('subagent', 'extension'), true)
  assert.equal(isPiSubagentTool('subagent', 'mcp'), false)
  assert.equal(isPiSubagentTool('subagent', undefined, 'remote'), false)
  assert.equal(isPiSubagentTool('subagent', 'unknown', 'remote'), false)
  assert.equal(isPiSubagentTool('my-subagent'), false)
  assert.equal(isPiSubagentTool('subagent_worker'), false)
  assert.equal(isPiSubagentTool('Subagent'), false)
  // Identity alone must not fabricate mode, count, child sessions or success.
  assert.equal(piSubagentToolDetails('subagent', undefined), undefined)
  assert.equal(piSubagentToolDetails('subagent', { results: [{ agent: 'scout' }] }), undefined)
})

test('only official tool details are recognized, malformed evidence is not guessed', () => {
  const details = { mode: 'parallel', results: [{ agent: 'scout' }] }
  assert.equal(piSubagentToolDetails('bash', details), undefined)
  assert.equal(piSubagentToolDetails('subagent', { results: details.results }), undefined)
  assert.equal(piSubagentToolDetails('subagent', { mode: 'unknown', results: details.results }), undefined)
  assert.equal(piSubagentToolDetails('subagent', { mode: 'single', results: {} }), undefined)
  assert.equal(piSubagentResult({ status: 'completed' }), undefined)
  assert.equal(piSubagentResult({ agent: 'scout', status: 'garbled' })?.status, 'unknown')
})

test('child status, model, usage and original messages are retained without estimated totals', () => {
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'finished' }] }]
  const child = piSubagentResult({
    agent: 'reviewer', status: 'failed', task: 'inspect issue', model: 'provider/model',
    step: 2, errorMessage: 'bad token', usage: { input: 18, output: 4, cost: 0.01, turns: 2 },
    messages,
  })
  assert.deepEqual(child, {
    agent: 'reviewer', status: 'failed', task: 'inspect issue', model: 'provider/model',
    step: 2, errorMessage: 'bad token',
    usage: { input: 18, output: 4, cost: 0.01, turns: 2 }, messages,
  })
})

test('subagent messages keep text, thinking, tool call and raw-only unknown content', () => {
  const parsed = piSubagentTranscriptMessage({ role: 'assistant', content: [
    { type: 'text', text: 'reviewing' },
    { type: 'thinking', thinking: 'check imports' },
    { type: 'toolCall', name: 'read', arguments: { path: 'src/main.ts' } },
    { type: 'image', data: 'base64' },
  ] })
  assert.equal(parsed?.role, 'assistant')
  assert.deepEqual(parsed?.parts.map(part => part.kind), ['text', 'thinking', 'toolCall'])
  assert.match(parsed?.parts[2]?.text ?? '', /src\/main\.ts/)
  assert.equal(parsed?.omittedParts, 1, 'unrecognized image content must not silently disappear')
  assert.deepEqual(piSubagentTranscriptMessage({ role: 'user', content: 'Task: inspect' })?.parts,
    [{ kind: 'text', text: 'Task: inspect', truncated: false }])
  assert.equal(piSubagentTranscriptMessage({ role: 'system', content: [] }), undefined)
  assert.equal(piSubagentTranscriptMessage({ role: 'user', content: [
    { type: 'text', text: 'x'.repeat(17_000) },
  ] })?.parts[0]?.truncated, true)
})

test('workflow and management envelopes of the current extension are recognized', () => {
  assert.equal(piSubagentToolDetails('subagent', { mode: 'workflow', results: [], runId: 'r1' })?.mode, 'workflow')
  assert.equal(piSubagentToolDetails('subagent', { mode: 'management', results: [], agentCapabilities: { agents: [] } })?.mode, 'management')
  // The versioned child inventory is accepted on any dispatch mode.
  const status = piSubagentToolDetails('subagent', {
    mode: 'single',
    results: [],
    workflowChildren: {
      version: 1,
      parentToolCallId: 'call_parent',
      workflowRunId: 'run_parent',
      inventoryComplete: false,
      workflowState: 'running',
      children: [
        { childId: 'auth', state: 'completed', runId: '584a', agent: 'scout', model: 'mimo-v2.6-flash', thinking: 'low' },
        { childId: 'tasks', state: 'running' },
      ],
    },
  })
  assert.equal(status?.workflowChildren?.workflowState, 'running')
  assert.equal(status?.workflowChildren?.inventoryComplete, false)
  assert.deepEqual(
    status?.workflowChildren?.children.map(child => [child.childId, child.state]),
    [['auth', 'completed'], ['tasks', 'running']],
  )
  assert.equal(status?.workflowChildren?.children[0]?.agent, 'scout')
  assert.equal(Object.hasOwn(status!, 'childSessionId'), false)
})

test('malformed or unknown-version workflowChildren is dropped while mode/results stay valid', () => {
  const base = { mode: 'single', results: [] as unknown[] }
  const withChildren = (workflowChildren: unknown) => piSubagentToolDetails('subagent', { ...base, workflowChildren })
  assert.equal(withChildren({ version: 2, inventoryComplete: true, workflowState: 'running', children: [] })?.workflowChildren, undefined)
  assert.equal(withChildren({ version: 1, inventoryComplete: true, workflowState: 'unknown-state', children: [] })?.workflowChildren, undefined)
  assert.equal(withChildren({ version: 1, workflowState: 'running', children: [] })?.workflowChildren, undefined)
  assert.equal(withChildren({ version: 1, inventoryComplete: true, workflowState: 'running', children: [{ childId: 'a', state: 'garbled' }] })?.workflowChildren, undefined)
  assert.equal(withChildren({ version: 1, inventoryComplete: true, workflowState: 'running', children: [null] })?.workflowChildren, undefined)
  // A broken inventory never invalidates the independently valid envelope.
  assert.deepEqual(withChildren({ version: 9 }), { mode: 'single', results: [] })
})

test('summary prefers the workflow envelope and never invents a zero-child claim', () => {
  const summaryOf = (details: unknown) => piSubagentSummary(piSubagentToolDetails('subagent', details)!)
  // status snapshot: dispatched as single with empty results, 4 real children.
  assert.deepEqual(summaryOf({
    mode: 'single',
    results: [],
    workflowChildren: {
      version: 1,
      inventoryComplete: false,
      workflowState: 'running',
      children: [
        { childId: 'auth', state: 'completed' },
        { childId: 'tasks', state: 'running' },
        { childId: 'focus', state: 'running' },
        { childId: 'stats', state: 'completed' },
      ],
    },
  }), { mode: 'workflow', count: 4, workflowState: 'running' })
  // launch snapshot: inventory still assembling, so no count instead of 0.
  assert.deepEqual(summaryOf({
    mode: 'workflow',
    results: [],
    workflowChildren: { version: 1, inventoryComplete: false, workflowState: 'running', children: [] },
  }), { mode: 'workflow', workflowState: 'running' })
  // a complete empty inventory truthfully reports 0.
  assert.deepEqual(summaryOf({
    mode: 'workflow',
    results: [],
    workflowChildren: { version: 1, inventoryComplete: true, workflowState: 'completed', children: [] },
  }), { mode: 'workflow', count: 0, workflowState: 'completed' })
  // management calls never claim child tasks.
  assert.deepEqual(summaryOf({ mode: 'management', results: [] }), { mode: 'management' })
  // legacy results keep their count; empty legacy results no longer claim 0.
  assert.deepEqual(summaryOf({ mode: 'chain', results: [{ agent: 'a' }] }), { mode: 'chain', count: 1 })
  assert.deepEqual(summaryOf({ mode: 'single', results: [] }), { mode: 'single' })
})

test('status snapshot row renders the workflow inventory instead of a zero-child claim', () => {
  const html = renderToStaticMarkup(createElement(TaskToolRow, {
    model: {
      id: 'tool:subagent-status', callId: 'call_67facb3fbc7a4099bd89c5a0',
      name: 'subagent', kind: 'tool', kindLabel: '子智能体', status: 'success',
      resultDetails: {
        mode: 'single',
        results: [],
        workflowChildren: {
          version: 1,
          parentToolCallId: 'call_fac96d69303a44cab07c769d',
          workflowRunId: '3e3853c1-cec8-42cb-bfbc-9438b203324b',
          inventoryComplete: false,
          workflowState: 'running',
          children: [
            { childId: 'auth', state: 'completed', runId: '584adc68', agent: 'scout', model: 'mimo-v2.6-flash', thinking: 'low' },
            { childId: 'tasks', state: 'running', runId: 'c694cada', agent: 'scout', model: 'mimo-v2.6-flash', thinking: 'low' },
            { childId: 'focus', state: 'running', runId: '646c9c49', agent: 'scout', model: 'mimo-v2.6-flash', thinking: 'low' },
            { childId: 'stats', state: 'completed', runId: 'fe1049d2', agent: 'scout', model: 'mimo-v2.6-flash', thinking: 'low' },
          ],
        },
      },
    },
  }))
  const summary = html.match(/<summary class="task-tool-row"[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? ''
  assert.match(summary, /task-tool-kind-subagent/)
  assert.match(summary, /工作流/)
  assert.match(summary, /4 个子任务/)
  assert.match(summary, /执行中/)
  assert.doesNotMatch(summary, /0 个子任务/)
  assert.doesNotMatch(summary, /单任务/)
})

test('workflow launch and management rows never claim child tasks', () => {
  const launch = renderToStaticMarkup(createElement(TaskToolRow, {
    model: {
      id: 'tool:subagent-launch', callId: 'call_launch', name: 'subagent',
      kind: 'tool', kindLabel: '子智能体', status: 'success',
      resultDetails: {
        mode: 'workflow',
        results: [],
        runId: '3e3853c1',
        workflowChildren: { version: 1, inventoryComplete: false, workflowState: 'running', children: [] },
      },
    },
  }))
  const launchSummary = launch.match(/<summary class="task-tool-row"[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? ''
  assert.match(launchSummary, /工作流/)
  assert.match(launchSummary, /执行中/)
  assert.doesNotMatch(launchSummary, /个子任务/)

  const management = renderToStaticMarkup(createElement(TaskToolRow, {
    model: {
      id: 'tool:subagent-management', callId: 'call_mgmt', name: 'subagent',
      kind: 'tool', kindLabel: '子智能体', status: 'success',
      resultDetails: { mode: 'management', results: [], agentCapabilities: { agents: [] } },
    },
  }))
  const managementSummary = management.match(/<summary class="task-tool-row"[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? ''
  assert.match(managementSummary, /管理操作/)
  assert.doesNotMatch(managementSummary, /个子任务/)

  const emptySingle = renderToStaticMarkup(createElement(TaskToolRow, {
    model: {
      id: 'tool:subagent-empty', callId: 'call_empty', name: 'subagent',
      kind: 'tool', kindLabel: '子智能体', status: 'success',
      resultDetails: { mode: 'single', results: [] },
    },
  }))
  assert.doesNotMatch(emptySingle, /0 个子任务/)
})
