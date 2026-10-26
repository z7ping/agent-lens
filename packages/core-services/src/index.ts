import { AGENT_LENS_PLUGIN_API_VERSION } from '@agent-lens/core'
import type {
  ,
} from '@agent-lens/core'

function assertPluginManifest(manifest: AgentLensPluginManifest, type: AgentLensPluginManifest['pluginType']): void {
  if (manifest.pluginType !== type
    || manifest.apiVersion !== AGENT_LENS_PLUGIN_API_VERSION
    || !manifest.pluginId?.trim()
    || !manifest.pluginVersion?.trim()
    || !manifest.displayName?.trim()) {
    throw new Error(`AgentLens ${type} manifest invalid or incompatible`)
  }
}

export class DefaultSourceService implements SourceService {
  private readonly definitions = new Map<string, SourceDefinition>()

  register(definition: SourceDefinition): Disposable {
    const manifest = definition.manifest
    const id = manifest.sourceId
    assertPluginManifest(manifest, 'source')
    if (!id?.trim() || !manifest.productId?.trim() || !manifest.parserVersion?.trim()) {
      throw new Error('AgentLens source manifest invalid or incompatible')
    }
    for (const method of ['detect', 'declareCapabilities', 'normalize'] as const) {
      if (typeof definition[method] !== 'function') {
        throw new Error(`AgentLens source missing required ${method}(): ${id}`)
      }
    }
    if (this.definitions.has(id)) {
      throw new Error(`AgentLens source already registered: ${id}`)
    }
    this.definitions.set(id, definition)
    return {
      dispose: () => {
        if (this.definitions.get(id) === definition) this.definitions.delete(id)
      },
    }
  }

  list(): SourceDefinition[] {
    return [...this.definitions.values()]
  }

  async detect(context: SourceDetectionContext): Promise<DetectedSource[]> {
    const detected = await Promise.all(this.list().map(async source => {
      const found = await source.detect(context)
      for (const installation of found) {
        if (installation.sourceId !== source.manifest.sourceId
          || installation.productId !== source.manifest.productId) {
          throw new Error(`AgentLens source detection identity mismatch: ${source.manifest.sourceId}`)
        }
      }
      return found
    }))
    return detected.flat()
  }
}

export class DefaultLiveService implements LiveService {
  private readonly adapters = new Map<string, LiveAdapter>()
  private readonly observers = new Set<LiveRuntimeObserver>()

  register(adapter: LiveAdapter): Disposable {
    assertPluginManifest(adapter.manifest, 'live')
    const id = adapter.manifest.liveId
    if (!id?.trim() || !adapter.manifest.productId?.trim()) {
      throw new Error('AgentLens live manifest invalid or incompatible')
    }
    if (this.adapters.has(id)) {
      throw new Error(`AgentLens live adapter already registered: ${id}`)
    }

    const declaresThinkingControl = adapter.capabilities.has('thinking-control')
    const implementsThinkingControl = typeof adapter.thinkingControl === 'function'
      && typeof adapter.setThinkingControl === 'function'
    if (declaresThinkingControl !== implementsThinkingControl) {
      throw new Error(
        `AgentLens live adapter thinking-control capability/method mismatch: ${id}`,
      )
    }

    // A capability must never be advertised without a real implementation.
    // All Agent-specific differences remain in adapters; Product Surface only
    // sees capabilities that this registry has verified at the boundary.
    const declared = [...adapter.capabilities]
    const advertised = adapter.manifest.capabilities ?? []
    if (declared.length !== new Set(declared).size
      || advertised.length !== new Set(advertised).size
      || declared.length !== advertised.length
      || declared.some(capability => !advertised.includes(capability))) {
      throw new Error(`AgentLens live adapter manifest/capability mismatch: ${id}`)
    }
    const requiredMethods = {
      resume: ['resume'],
      fork: ['fork'],
      'fork-at': ['forkAt'],
      interrupt: ['interrupt'],
      queue: ['queueState', 'clearQueue'],
      'model-switching': ['modelControl', 'setModelControl'],
      'thinking-control': ['thinkingControl', 'setThinkingControl'],
      'extension-ui': ['respondToExtension'],
      'command-discovery': ['commands'],
      'workspace-file-reference': ['workspaceFileReferences'],
      'history-index': ['historyIndex'],
      'session-tree': ['sessionTree'],
    } as const
    for (const [capability, methods] of Object.entries(requiredMethods)) {
      if (!adapter.capabilities.has(capability as keyof typeof requiredMethods)) continue
      for (const method of methods) {
        if (typeof adapter[method as keyof LiveAdapter] !== 'function') {
          throw new Error(`AgentLens live adapter ${capability} capability requires ${method}(): ${id}`)
        }
      }
    }
    if (adapter.capabilities.has('steer') && !adapter.capabilities.has('queue')) {
      throw new Error(`AgentLens live adapter steer requires queue capability: ${id}`)
    }

    const watchers = new Map<string, () => void>()
    const terminalSettled = new Set<string>()
    const originalSend = adapter.send
    const originalInterrupt = adapter.interrupt
    const originalTerminate = adapter.terminate
    const originalDispose = adapter.dispose

    const observerContext = (runtime: Awaited<ReturnType<LiveAdapter['state']>>): LiveRuntimeObserverContext => ({
      liveId: adapter.manifest.liveId,
      productId: adapter.manifest.productId,
      runtime,
    })

    const notifyBeforeSend = async (runtimeSessionId: string) => {
      if (!this.observers.size) return
      const runtime = await adapter.state(runtimeSessionId)
      const context = observerContext(runtime)
      await Promise.all([...this.observers].map(observer =>
        Promise.resolve(observer.beforeSend?.(context)).catch(error => {
          console.warn('[AgentLens] Live runtime observer beforeSend failed', error)
        }),
      ))
    }

    const notifySettled = async (
      runtimeSessionId: string,
      reason: LiveRuntimeSettledContext['reason'],
      event?: LiveRuntimeEvent,
      knownRuntime?: Awaited<ReturnType<LiveAdapter['state']>>,
    ) => {
      const terminal = reason === 'terminated' || reason === 'failed'
      if (terminal && terminalSettled.has(runtimeSessionId)) return
      if (terminal) terminalSettled.add(runtimeSessionId)
      if (!this.observers.size) return

      let runtime = knownRuntime
      if (!runtime) {
        try {
          runtime = await adapter.state(runtimeSessionId)
        } catch (error) {
          console.warn('[AgentLens] Live runtime observer state lookup failed', error)
          return
        }
      }
      const context: LiveRuntimeSettledContext = {
        ...observerContext(runtime),
        reason,
        ...(event ? { event } : {}),
      }
      await Promise.all([...this.observers].map(observer =>
        Promise.resolve(observer.settled?.(context)).catch(error => {
          console.warn('[AgentLens] Live runtime observer settled failed', error)
        }),
      ))
    }

    const ensureWatcher = (runtimeSessionId: string) => {
      if (watchers.has(runtimeSessionId) || !adapter.capabilities.has('stream')) return
      const unsubscribe = adapter.subscribe(runtimeSessionId, event => {
        const normalized = event.normalizedEvent
        const completed = normalized?.type === 'completed'
        const terminalStatus = normalized?.type === 'status'
          && (normalized.status === 'failed' || normalized.status === 'terminated')
        if (completed) {
          void notifySettled(
            runtimeSessionId,
            normalized.status === 'failed' ? 'failed' : 'completed',
            event,
          )
        } else if (terminalStatus) {
          void notifySettled(
            runtimeSessionId,
            normalized.status === 'failed' ? 'failed' : 'terminated',
            event,
          )
        }
      })
      watchers.set(runtimeSessionId, unsubscribe)
    }

    const decoratedSend: LiveAdapter['send'] = async (runtimeSessionId, message, options) => {
      await notifyBeforeSend(runtimeSessionId)
      ensureWatcher(runtimeSessionId)
      return originalSend.call(adapter, runtimeSessionId, message, options)
    }
    adapter.send = decoratedSend

    let decoratedInterrupt: LiveAdapter['interrupt'] | undefined
    if (originalInterrupt) {
      decoratedInterrupt = async runtimeSessionId => {
        const result = await originalInterrupt.call(adapter, runtimeSessionId)
        await notifySettled(runtimeSessionId, 'interrupted')
        return result
      }
      adapter.interrupt = decoratedInterrupt
    }

    const decoratedTerminate: LiveAdapter['terminate'] = async runtimeSessionId => {
      let runtime: Awaited<ReturnType<LiveAdapter['state']>> | undefined
      try {
        runtime = await adapter.state(runtimeSessionId)
      } catch {
        runtime = undefined
      }
      if (runtime) await notifySettled(runtimeSessionId, 'terminated', undefined, runtime)
      watchers.get(runtimeSessionId)?.()
      watchers.delete(runtimeSessionId)
      return originalTerminate.call(adapter, runtimeSessionId)
    }
    adapter.terminate = decoratedTerminate

    const decoratedDispose: LiveAdapter['dispose'] = async () => {
      for (const unsubscribe of watchers.values()) unsubscribe()
      watchers.clear()
      terminalSettled.clear()
      return originalDispose.call(adapter)
    }
    adapter.dispose = decoratedDispose

    this.adapters.set(id, adapter)
    return {
      dispose: () => {
        if (this.adapters.get(id) !== adapter) return
        for (const unsubscribe of watchers.values()) unsubscribe()
        watchers.clear()
        terminalSettled.clear()
        if (adapter.send === decoratedSend) adapter.send = originalSend
        if (originalInterrupt && decoratedInterrupt && adapter.interrupt === decoratedInterrupt) {
          adapter.interrupt = originalInterrupt
        }
        if (adapter.terminate === decoratedTerminate) adapter.terminate = originalTerminate
        if (adapter.dispose === decoratedDispose) adapter.dispose = originalDispose
        this.adapters.delete(id)
      },
    }
  }

  observe(observer: LiveRuntimeObserver): Disposable {
    this.observers.add(observer)
    return {
      dispose: () => {
        this.observers.delete(observer)
      },
    }
  }

  list(): LiveAdapter[] {
    return [...this.adapters.values()]
  }

  get(liveId: string): LiveAdapter | null {
    return this.adapters.get(liveId) ?? null
  }
}

export class DefaultCapabilityService implements CapabilityService {
  private readonly values = new Map<string, Map<string, ObservationCapability>>()

  registerSourceCapabilities(sourceId: string, capabilities: ObservationCapability[]): Disposable {
    const next = new Map(capabilities.map(item => [item.name, item]))
    this.values.set(sourceId, next)
    return { dispose: () => { if (this.values.get(sourceId) === next) this.values.delete(sourceId) } }
  }

  listForSource(sourceId: string): ObservationCapability[] {
    return [...(this.values.get(sourceId)?.values() ?? [])]
  }

  get(sourceId: string, capability: string): ObservationCapability | null {
    return this.values.get(sourceId)?.get(capability) ?? null
  }
}

export * from './live-attachments'

export * from './native-session-reader'
export { NativeReaderWorkerClient, resolveNativeReaderWorkerUrl, type NativeReaderWorkerPort } from './native-reader-worker-client'
export type {
  NativeWorkerReadInput, NativeWorkerReadResult,
  NativeWorkerHookReadInput, NativeWorkerHookReadResult,
  NativeWorkerRequest, NativeWorkerReply,
} from './native-reader-worker-protocol'

export * from './native-only-source-indexer'
export * from './native-session-deep-audit'

export * from './native-only-asset-scanner'

export * from './native-only-runtime-capture'
