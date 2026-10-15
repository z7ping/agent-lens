/**
 * Windows Task Scheduler may report a task as Ready before its child Daemon
 * has exited. Treat scheduler state and service-owned health as independent
 * shutdown facts, and do not report success until both have settled.
 */
export interface ServiceStopState {
  taskActive: boolean
  serviceOwnedRuntimeOnline: boolean
}

export async function waitForServiceStop(
  initial: ServiceStopState,
  refresh: () => Promise<ServiceStopState>,
  pause: (milliseconds: number) => Promise<void>,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<ServiceStopState> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMs ?? 12_000)
  const pollMs = options.pollMs ?? 250
  let state = initial
  while ((state.taskActive || state.serviceOwnedRuntimeOnline) && now() < deadline) {
    await pause(Math.min(pollMs, Math.max(1, deadline - now())))
    state = await refresh()
  }
  return state
}
