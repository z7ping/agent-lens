export const STORAGE_BUDGET_POLICY_VERSION = 1 as const

export type StorageBudgetPreset = 'space-saver' | 'balanced' | 'full-retention'

export interface StorageBudgetWatermarks {
  lowBytes: number
  highBytes: number
}

export interface StorageBudgetPolicy {
  version: typeof STORAGE_BUDGET_POLICY_VERSION
  preset: StorageBudgetPreset
  hot: StorageBudgetWatermarks
  total: StorageBudgetWatermarks
}

export type StorageBudgetState = 'healthy' | 'approaching' | 'exceeded'

export interface StorageBudgetUsage {
  footprintBytes: number
  lowWatermarkBytes: number
  highWatermarkBytes: number
  ratio: number
  state: StorageBudgetState
}

const MIB = 1024 * 1024
const GIB = 1024 * MIB

export const STORAGE_BUDGET_PRESETS: Readonly<Record<StorageBudgetPreset, StorageBudgetPolicy>> = {
  'space-saver': {
    version: STORAGE_BUDGET_POLICY_VERSION,
    preset: 'space-saver',
    hot: { highBytes: GIB, lowBytes: 768 * MIB },
    total: { highBytes: 2 * GIB, lowBytes: 1536 * MIB },
  },
  balanced: {
    version: STORAGE_BUDGET_POLICY_VERSION,
    preset: 'balanced',
    hot: { highBytes: 2 * GIB, lowBytes: 1536 * MIB },
    total: { highBytes: 4 * GIB, lowBytes: 3 * GIB },
  },
  'full-retention': {
    version: STORAGE_BUDGET_POLICY_VERSION,
    preset: 'full-retention',
    hot: { highBytes: 4 * GIB, lowBytes: 3 * GIB },
    total: { highBytes: 8 * GIB, lowBytes: 6 * GIB },
  },
}

function validWatermarks(value: unknown): value is StorageBudgetWatermarks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Number.isSafeInteger(item.lowBytes)
    && Number.isSafeInteger(item.highBytes)
    && Number(item.lowBytes) > 0
    && Number(item.lowBytes) < Number(item.highBytes)
}

export function isStorageBudgetPolicy(value: unknown): value is StorageBudgetPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  if (policy.version !== STORAGE_BUDGET_POLICY_VERSION) return false
  if (policy.preset !== 'space-saver' && policy.preset !== 'balanced' && policy.preset !== 'full-retention') return false
  if (!validWatermarks(policy.hot) || !validWatermarks(policy.total)) return false
  return policy.total.lowBytes >= policy.hot.lowBytes
    && policy.total.highBytes >= policy.hot.highBytes
}

export function storageBudgetPreset(preset: StorageBudgetPreset = 'balanced'): StorageBudgetPolicy {
  const value = STORAGE_BUDGET_PRESETS[preset]
  return {
    ...value,
    hot: { ...value.hot },
    total: { ...value.total },
  }
}

/**
 * 高低水位的状态描述不持有回收循环状态：达到高水位即超限；
 * 落到低水位以下才恢复健康；中间区间需要由治理器继续回收到低水位。
 */
export function describeStorageBudgetUsage(
  footprintBytes: number,
  watermarks: StorageBudgetWatermarks,
): StorageBudgetUsage {
  const normalizedFootprint = Math.max(0, footprintBytes)
  const ratio = watermarks.highBytes > 0 ? normalizedFootprint / watermarks.highBytes : 0
  return {
    footprintBytes: normalizedFootprint,
    lowWatermarkBytes: watermarks.lowBytes,
    highWatermarkBytes: watermarks.highBytes,
    ratio,
    state: normalizedFootprint >= watermarks.highBytes
      ? 'exceeded'
      : normalizedFootprint >= watermarks.lowBytes
        ? 'approaching'
        : 'healthy',
  }
}
