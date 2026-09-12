import { watch, type FSWatcher } from 'chokidar'

export type SourceFileWatchEvent = 'add' | 'change' | 'unlink'

export interface SourceFileWatchOptions {
  paths: string | readonly string[]
  signal: AbortSignal
  onFile(filePath: string, event: SourceFileWatchEvent): void | Promise<void>
  accept?: (filePath: string, event: SourceFileWatchEvent) => boolean
  debounceMs?: number
  onError?: (error: unknown) => void
}

export interface SourceFileWatchHandle {
  dispose(): Promise<void>
}

export async function watchSourceFiles(
  options: SourceFileWatchOptions,
): Promise<SourceFileWatchHandle> {
  if (options.signal.aborted) return { async dispose() {} }

  const debounceMs = options.debounceMs ?? 120
  let stopped = false
  let watcher: FSWatcher | null = null
  let processing = Promise.resolve()
  const pending = new Map<string, { timer: NodeJS.Timeout; event: SourceFileWatchEvent }>()

  const reportError = (error: unknown) => {
    try {
      options.onError?.(error)
    } catch {
      // Error reporting must never break watcher lifecycle.
    }
  }

  const enqueue = (filePath: string, event: SourceFileWatchEvent) => {
    processing = processing
      .then(async () => {
        if (stopped || options.signal.aborted) return
        await options.onFile(filePath, event)
      })
      .catch(reportError)
  }

  const schedule = (filePath: string, event: SourceFileWatchEvent) => {
    if (stopped || options.signal.aborted) return
    if (options.accept && !options.accept(filePath, event)) return

    const previous = pending.get(filePath)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => {
      pending.delete(filePath)
      enqueue(filePath, event)
    }, debounceMs)
    pending.set(filePath, { timer, event })
  }

  watcher = watch(options.paths as string | string[], {
    ignoreInitial: true,
    persistent: true,
    atomic: true,
  })
  watcher.on('add', path => schedule(path, 'add'))
  watcher.on('change', path => schedule(path, 'change'))
  watcher.on('unlink', path => schedule(path, 'unlink'))
  watcher.on('error', reportError)

  const abort = () => {
    if (stopped) return
    stopped = true
    for (const { timer } of pending.values()) clearTimeout(timer)
    pending.clear()
    const active = watcher
    watcher = null
    if (active) void active.close().catch(reportError)
  }
  options.signal.addEventListener('abort', abort, { once: true })

  return {
    async dispose(): Promise<void> {
      if (!stopped) {
        stopped = true
        for (const { timer } of pending.values()) clearTimeout(timer)
        pending.clear()
        options.signal.removeEventListener('abort', abort)
        const active = watcher
        watcher = null
        if (active) await active.close().catch(reportError)
      } else {
        options.signal.removeEventListener('abort', abort)
      }
      await processing
    },
  }
}
