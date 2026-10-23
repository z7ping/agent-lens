/** Provider-derived counters reported by the pi-cache-optimizer extension footer.
 * Tokens are strings because footer precision is rounded; never claim exact values.
 */
export interface PiLiveCacheMetrics {
  source: 'pi-cache-optimizer'
  adapter: string
  hitRequests: number
  totalRequests: number
  cachedInput: string
  totalInput: string
  tokenHitRate: number
  compatibility: 'ok' | 'warning' | 'disabled'
  integrityWarning?: boolean | undefined
}

/** Interpret only the documented extension-owned status key/format.
 * Never infer cache hits or DS compatibility from general model usage or Pi runtime mode.
 */
export function parsePiCacheOptimizerStatus(
  event: Readonly<Record<string, unknown>>,
): PiLiveCacheMetrics | null | undefined {
  if (event.type !== 'extension_ui_request' || event.method !== 'setStatus'
    || event.statusKey !== 'pi-cache-stats') return undefined
  if (typeof event.statusText !== 'string' || !event.statusText.trim()) return null
  const text = event.statusText.trim().replace(/^·\s*/, '')
  const disabled = text.startsWith('Cache Optimizer disabled · ')
  const source = disabled ? text.slice('Cache Optimizer disabled · '.length) : text
  const match = /^([\w-]{2,42}) cache (\d+)\/(\d+)·(\d+(?:\.\d+)?M)\/(\d+(?:\.\d+)?M) (\d+(?:\.\d+)?)%(?:\s*·write\s+[\w.]+)?(?:\s+⚠️?\s+(?:compat|integrity))*$/.exec(source)
  if (!match) return null
  const hits = Number(match[2])
  const total = Number(match[3])
  const rate = Number(match[6])
  if (!Number.isSafeInteger(hits) || !Number.isSafeInteger(total) || hits > total
    || !Number.isFinite(rate) || rate < 0 || rate > 100) return null
  return {
    source: 'pi-cache-optimizer',
    adapter: match[1]!,
    hitRequests: hits,
    totalRequests: total,
    cachedInput: match[4]!,
    totalInput: match[5]!,
    tokenHitRate: rate,
    compatibility: disabled ? 'disabled' : /⚠️?\s+compat/.test(source) ? 'warning' : 'ok',
    ...(/⚠️?\s+integrity/.test(source) ? { integrityWarning: true } : {}),
  }
}
