import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface HistoryFileWatchOptions {
  root: string
  signal: AbortSignal
  onFile(filePath: string): Promise<void>
  listFiles?: (limit?: number) => Promise<string[]>
  accept?: (filePath: string) => boolean
  debounceMs?: number
  fallbackPollMs?: number
  fallbackReconcileLimit?: number
  reconcilePollMs?: number
  reconcileLimit?: number
  initialReconcileLimit?: number
  onError?: (error: unknown) => void
}

export interface HistoryFileWatchHandle {
  dispose(): Promise<void>
}

export async function startHistoryFileWatch(
  options: HistoryFileWatchOptions,
): Promise<HistoryFileWatchHandle> {
  if (options.signal.aborted) return { async dispose() {} }

  const debounceMs = options.debounceMs ?? 180
  let stopped = false
  let watcher: FSWatcher | null = null
  let fallbackTimer: NodeJS.Timeout | null = null
  let reconcileTimer: NodeJS.Timeout | null = null
  const debounce = new Map<string, NodeJS.Timeout>()
  let processing = Promise.resolve()

  const reportError = (error: unknown) => {
    try {
      options.onError?.(error)
    } catch {
      // Error reporting must never break the watcher lifecycle.
    }
  }

  const processFile = (filePath: string) => {
    processing = processing
      .then(async () => {
        if (stopped || options.signal.aborted) return
        await options.onFile(filePath)
      })
      .catch(reportError)
  }

  const schedule = (filePath: string) => {
    if (stopped || options.signal.aborted) return
    if (options.accept && !options.accept(filePath)) return
    const previous = debounce.get(filePath)
    if (previous) clearTimeout(previous)
    debounce.set(filePath, setTimeout(() => {
      debounce.delete(filePath)
      processFile(filePath)
    }, debounceMs))
  }

  const reconcile = async (limit?: number) => {
    if (stopped || options.signal.aborted || !options.listFiles) return
    try {
      for (const filePath of await options.listFiles(limit)) schedule(filePath)
    } catch (error) {
      reportError(error)
    }
  }

  const startFallbackPolling = () => {
    if (fallbackTimer || !options.listFiles || !options.fallbackPollMs) return
    fallbackTimer = setInterval(() => {
      void reconcile(options.fallbackReconcileLimit)
    }, options.fallbackPollMs)
  }

  try {
    watcher = watch(options.root, { recursive: true }, (_event, fileName) => {
      if (!fileName) {
        void reconcile(options.reconcileLimit)
        return
      }
      schedule(join(options.root, fileName.toString()))
    })
    watcher.on('error', error => {
      reportError(error)
      watcher?.close()
      watcher = null
      if (reconcileTimer) clearInterval(reconcileTimer)
      reconcileTimer = null
      startFallbackPolling()
    })
  } catch (error) {
    reportError(error)
    watcher = null
    startFallbackPolling()
  }

  if (watcher && options.listFiles && options.reconcilePollMs) {
    reconcileTimer = setInterval(() => {
      void reconcile(options.reconcileLimit)
    }, options.reconcilePollMs)
  }

  if (
    options.listFiles
    && options.initialReconcileLimit !== undefined
    && options.initialReconcileLimit > 0
  ) {
    void reconcile(options.initialReconcileLimit)
  }

  const abort = () => {
    stopped = true
    watcher?.close()
    watcher = null
    if (fallbackTimer) clearInterval(fallbackTimer)
    if (reconcileTimer) clearInterval(reconcileTimer)
    fallbackTimer = null
    reconcileTimer = null
    for (const timer of debounce.values()) clearTimeout(timer)
    debounce.clear()
  }
  options.signal.addEventListener('abort', abort, { once: true })

  return {
    async dispose(): Promise<void> {
      if (!stopped) abort()
      options.signal.removeEventListener('abort', abort)
      await processing
    },
  }
}
