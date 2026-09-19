import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'
import type { PiLiveRuntimeState, PiLiveStartInput } from './types'

class MemoryRecoveryStore implements PiLiveRecoveryStore {
  readonly records = new Map<string, PiLiveRecoveryRecord>()

  constructor(initial: PiLiveRecoveryRecord[] = []) {
    for (const item of initial) this.records.set(item.id, item)
  }

  async list(): Promise<PiLiveRecoveryRecord[]> { return [...this.records.values()] }
  async put(record: PiLiveRecoveryRecord): Promise<void> { this.records.set(record.id, record) }
  async remove(id: string): Promise<void> { this.records.delete(id) }
}

function parseEntries(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      return value.type === 'session' ? [] : [value]
    } catch {
      return []
    }
  })
}

class LifecycleHost implements PiRuntimeHost {
  starts = 0
  terminations = 0
  streaming = false

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    _signal: AbortSignal,
    _onEvent: (event: Record<string, unknown>) => void,
    _onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    this.starts += 1
    const processId = this.starts
    const sessionFile = input.sessionPath
    if (!sessionFile) throw new Error('test host requires sessionPath')
    const entries = parseEntries(await readFile(sessionFile, 'utf8'))
    const knownIds = new Set(entries.flatMap(entry => typeof entry.id === 'string' ? [entry.id] : []))
    const leafId = [...knownIds].at(-1) ?? null
    const state = (): PiLiveRuntimeState => ({
      runtimeSessionId,
      status: 'ready',
      nativeSessionId: 'native-session',
      sessionFile,
      isStreaming: this.streaming,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId,
      processId,
    })
    return {
      state: async () => state(),
      snapshot: async () => ({ state: state(), entries: [...entries], leafId, page: { hasEarlier: false } }),
      entry: async id => knownIds.has(id) ? entries.find(item => item.id === id) ?? { id } : null,
      controls: async () => ({ models: [] }),
      setModel: async () => state(),
      setThinkingLevel: async () => state(),
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      clearQueue: async () => ({ steering: [], followUp: [] }),
      abort: async () => ({ steering: [], followUp: [] }),
      respondToExtension: async () => {},
      terminate: async () => { this.terminations += 1 },
    }
  }
}

class BlockingLifecycleHost extends LifecycleHost {
  private releaseStart!: () => void
  private readonly startGate = new Promise<void>(resolve => { this.releaseStart = resolve })

  release(): void {
    this.releaseStart()
  }

  override async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    this.starts += 1
    onEvent({ type: 'runtime_initialization', stage: 'loading_sdk', message: 'Loading SDK' })
    await this.startGate
    this.starts -= 1
    return super.start(runtimeSessionId, input, signal, onEvent, onExit)
  }
}

async function waitForReady(service: DefaultPiLiveService, id: string): Promise<PiLiveRuntimeState> {
  for (let index = 0; index < 100; index += 1) {
    const state = await service.state(id)
    if (state.status === 'ready') return state
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error(`runtime ${id} did not become ready`)
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(message)
}

async function makeSession(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-lens-pi-runtime-'))
  const file = join(dir, 'session.jsonl')
  await writeFile(file, [
    JSON.stringify({ type: 'session', id: 'session-id' }),
    JSON.stringify({ type: 'message', id: 'entry-1', message: { role: 'user', content: 'hello' } }),
    '',
  ].join('\n'))
  return { dir, file }
}

test('mount snapshot reloads an idle runtime after another Pi process appends the JSONL', async () => {
  const { dir, file } = await makeSession()
  const host = new LifecycleHost()
  const service = new DefaultPiLiveService(host, new MemoryRecoveryStore(), undefined, { idleTimeoutMs: 0 })
  try {
    const started = await service.start({ cwd: dir, sessionPath: file, historyAction: 'continue' })
    await waitForReady(service, started.runtimeSessionId)
    const before = await service.snapshot(started.runtimeSessionId)
    assert.equal(host.starts, 1)
    assert.equal(before.entries.length, 1)

    await appendFile(file, JSON.stringify({ type: 'message', id: 'entry-2', message: { role: 'assistant', content: 'external' } }) + '\n')
    const after = await service.snapshot(started.runtimeSessionId)

    assert.equal(host.starts, 2)
    assert.ok(after.entries.some(entry => (entry as Record<string, unknown>).id === 'entry-2'))
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('external append does not rebuild a streaming runtime', async () => {
  const { dir, file } = await makeSession()
  const host = new LifecycleHost()
  const service = new DefaultPiLiveService(host, new MemoryRecoveryStore(), undefined, { idleTimeoutMs: 0 })
  try {
    const started = await service.start({ cwd: dir, sessionPath: file, historyAction: 'continue' })
    await waitForReady(service, started.runtimeSessionId)
    host.streaming = true
    await appendFile(file, JSON.stringify({ type: 'message', id: 'entry-2' }) + '\n')
    await service.snapshot(started.runtimeSessionId)
    assert.equal(host.starts, 1)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('persisted runtimes stay logical until selected and idle workers rehydrate on demand', async () => {
  const { dir, file } = await makeSession()
  const host = new LifecycleHost()
  const store = new MemoryRecoveryStore([{
    id: 'runtime-1',
    input: { cwd: dir, sessionPath: file, historyAction: 'continue' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
  }])
  const service = new DefaultPiLiveService(host, store, undefined, { idleTimeoutMs: 20 })
  try {
    const listed = await service.list()
    assert.equal(host.starts, 0)
    assert.equal(listed[0]?.status, 'ready')
    assert.equal(listed[0]?.sessionFile, file)

    const active = await service.state('runtime-1')
    assert.ok(active.status === 'initializing' || active.status === 'ready')
    await waitForReady(service, 'runtime-1')
    assert.equal(host.starts, 1)

    await waitFor(() => host.terminations >= 1, 'idle worker was not suspended')
    const suspended = await service.list()
    assert.equal(suspended[0]?.status, 'ready')
    assert.equal(suspended[0]?.processId, undefined)
    assert.equal(host.starts, 1)

    await service.state('runtime-1')
    assert.equal(host.starts, 2)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an SSE subscriber prevents idle suspension until it disconnects', async () => {
  const { dir, file } = await makeSession()
  const host = new LifecycleHost()
  const service = new DefaultPiLiveService(host, new MemoryRecoveryStore(), undefined, { idleTimeoutMs: 25 })
  try {
    const started = await service.start({ cwd: dir, sessionPath: file, historyAction: 'continue' })
    await waitForReady(service, started.runtimeSessionId)
    const unsubscribe = service.subscribe(started.runtimeSessionId, () => {})
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(host.terminations, 0)

    unsubscribe()
    await waitFor(() => host.terminations >= 1, 'worker did not suspend after subscriber left')
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('suspended Runtime state and SSE stay responsive while Worker hydration is blocked', async () => {
  const { dir, file } = await makeSession()
  const host = new BlockingLifecycleHost()
  const store = new MemoryRecoveryStore([{
    id: 'runtime-slow',
    input: { cwd: dir, sessionPath: file, historyAction: 'continue' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
  }])
  const service = new DefaultPiLiveService(host, store, undefined, { idleTimeoutMs: 0 })
  try {
    await service.list()
    const statuses: string[] = []
    const unsubscribe = service.subscribe('runtime-slow', event => {
      if (event.event.type === 'runtime_status' && typeof event.event.status === 'string') {
        statuses.push(event.event.status)
      }
    })

    await waitFor(() => host.starts === 1, 'hydration did not start')
    const state = await Promise.race([
      service.state('runtime-slow'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('state waited for Worker hydration')), 250)),
    ])

    assert.equal(state.status, 'initializing')
    assert.ok(statuses.includes('initializing'))

    const snapshot = await Promise.race([
      service.snapshot('runtime-slow'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot waited for Worker hydration')), 250)),
    ])
    assert.equal(snapshot.state.status, 'initializing')
    assert.deepEqual(snapshot.entries, [])

    host.release()
    const ready = await waitForReady(service, 'runtime-slow')
    assert.equal(ready.status, 'ready')
    unsubscribe()
  } finally {
    host.release()
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
