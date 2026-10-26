// 验收只读取正式 Native API，缺失、部分覆盖和空样本不能冒充完整数据。
export const nativeCatalogPath = '/api/v1/native-sessions'
export const nativeMetricsPath = `${nativeCatalogPath}/metrics/overview`
export const nativeReviewPath = id => `${nativeCatalogPath}/${encodeURIComponent(id)}/review?turnLimit=4`

export function nativeMetricSnapshot(body) {
  if (body?.state !== 'available' || !Array.isArray(body.items)) return null
  const totals = body.totals
  const keys = ['eligibleSessions', 'readySessions', 'missingSessions', 'staleSessions', 'partialSessions']
  if (!totals || keys.some(key => !Number.isSafeInteger(totals[key]) || totals[key] < 0)) return null
  if (totals.readySessions + totals.partialSessions + totals.missingSessions + totals.staleSessions !== totals.eligibleSessions) return null
  return { ...Object.fromEntries(keys.map(key => [key, totals[key]])), coverage: body.coverage }
}

export function readableNativeWindow(body) {
  return body?.state === 'available' && body.boundaryIntegrity === 'complete'
    && body.pendingTail === false && Array.isArray(body.interactions) && body.interactions.length > 0
}

export async function readNativeReview(base, id, { minTurns = 1, maxPages = 1000 } = {}) {
  const cursors = new Set(), ids = new Set()
  let cursor, turns = 0
  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(`${base}${nativeReviewPath(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
      signal: AbortSignal.timeout(5000),
    })
    const body = await response.json()
    if (!response.ok || body.state !== 'available' || body.boundaryIntegrity !== 'complete'
      || body.pendingTail || !Array.isArray(body.interactions)) throw new Error('原生轮次分页不可完整读取')
    for (const interaction of body.interactions) {
      if (!interaction.id || ids.has(interaction.id)) throw new Error('原生轮次 ID 无效或重复')
      ids.add(interaction.id); turns++
    }
    if (!body.hasMore) {
      if (turns < minTurns) throw new Error(`完整轮次不足：${turns}/${minTurns}`)
      return { turns, pages: page + 1, boundaryIntegrity: 'complete', hookFactsPartial: body.hookFactsPartial === true }
    }
    if (!body.nextCursor || cursors.has(body.nextCursor) || !body.interactions.length) throw new Error('原生轮次游标未推进')
    cursor = body.nextCursor; cursors.add(cursor)
  }
  throw new Error('原生轮次超过验收页预算')
}

export async function readNativeCatalog(base, { minSessions = 1, maxPages = 100, timeoutMs = 5000 } = {}) {
  const items = [], ids = new Set(), cursors = new Set()
  let cursor
  for (let page = 0; page < maxPages; page++) {
    const response = await fetch(`${base}${nativeCatalogPath}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`原生目录请求失败：${response.status}`)
    const body = await response.json()
    if (!Array.isArray(body.items) || typeof body.hasMore !== 'boolean') throw new Error('原生目录 DTO 无效')
    for (const item of body.items) {
      if (!/^native:[0-9a-f]{32}$/.test(item.id) || ids.has(item.id)) throw new Error('原生目录 ID 无效或分页重复')
      ids.add(item.id); items.push(item)
    }
    if (!body.hasMore) {
      if (items.length < minSessions) throw new Error(`原生目录样本不足：${items.length}/${minSessions}`)
      return items
    }
    if (!body.nextCursor || cursors.has(body.nextCursor)) throw new Error('原生目录游标未推进')
    cursor = body.nextCursor; cursors.add(cursor)
  }
  throw new Error('原生目录扫描超过验收页预算')
}
