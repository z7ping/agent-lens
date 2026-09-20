export function shareInFlight<T>(
  inFlight: Map<string, Promise<unknown>>,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>

  let pending!: Promise<T>
  pending = start().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  })
  inFlight.set(key, pending)
  return pending
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

export function waitForCaller<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    function cleanup() {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}


export interface AbortableInFlightEntry {
  promise: Promise<unknown>
  controller: AbortController
  callers: number
}

export function shareAbortableInFlight<T>(
  inFlight: Map<string, AbortableInFlightEntry>,
  key: string,
  start: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let entry = inFlight.get(key)
  if (!entry) {
    const controller = new AbortController()
    const created: AbortableInFlightEntry = {
      promise: Promise.resolve(undefined),
      controller,
      callers: 0,
    }
    const pending = start(controller.signal).finally(() => {
      if (inFlight.get(key) === created) inFlight.delete(key)
    })
    created.promise = pending
    inFlight.set(key, created)
    entry = created
  }

  entry.callers += 1
  let released = false
  const release = (aborted: boolean) => {
    if (released) return
    released = true
    entry!.callers = Math.max(0, entry!.callers - 1)
    if (aborted && entry!.callers === 0 && inFlight.get(key) === entry) entry!.controller.abort()
  }

  if (signal?.aborted) {
    release(true)
    return Promise.reject(abortError())
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      release(true)
      reject(abortError())
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })

    ;(entry!.promise as Promise<T>).then(
      value => {
        cleanup()
        release(false)
        resolve(value)
      },
      error => {
        cleanup()
        release(false)
        reject(error)
      },
    )
  })
}
