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

  const activeSignal = signal
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError())
    }
    function cleanup() {
      activeSignal.removeEventListener('abort', onAbort)
    }
    activeSignal.addEventListener('abort', onAbort, { once: true })
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
