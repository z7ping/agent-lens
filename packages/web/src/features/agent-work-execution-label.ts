/** Source-derived Hermes cron labels. Unknown values stay raw: do not invent success or delivery. */
const executionStatusKeys: Readonly<Record<string, string>> = {
  completed: 'work.executionCompleted',
  running: 'work.executionRunning',
  claimed: 'work.executionClaimed',
  failed: 'work.executionFailed',
  error: 'work.executionError',
  cancelled: 'work.executionCancelled',
  timed_out: 'work.executionTimedOut',
}
const deliveryOutcomeKeys: Readonly<Record<string, string>> = {
  suppressed: 'work.deliverySuppressed',
  delivered: 'work.deliveryDelivered',
  failed: 'work.deliveryFailed',
}

export function agentWorkExecutionStatusKey(nativeStatus: string): string | undefined {
  return executionStatusKeys[nativeStatus]
}

export function agentWorkDeliveryKey(nativeOutcome: string): string | undefined {
  return deliveryOutcomeKeys[nativeOutcome]
}

/** Show a bounded number of the already ordered native rows until explicitly expanded. */
export function visibleAgentWorkExecutions<T>(rows: readonly T[], showAll: boolean, previewCount = 5): readonly T[] {
  return showAll ? rows : rows.slice(0, previewCount)
}
