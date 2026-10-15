import { useEffect, useRef } from 'react'
import type { AgentLensClientModel, ClientSnapshot } from './model'

type ReviewFilters = ClientSnapshot['review']['filters']

function reviewFiltersFromSearch(search: string): ReviewFilters {
  const params = new URLSearchParams(search)
  const range = params.get('range')
  const status = params.get('status')
  return {
    sourceIds: params.has('source') ? [...new Set(params.getAll('source').map(value => value.trim()).filter(Boolean))] : null,
    projectId: params.get('project') ?? '',
    range: range === 'today' || range === '7d' || range === '30d' || range === 'all' ? range : '7d',
    status: status === 'clean' || status === 'with-errors' || status === 'all' ? status : 'all',
    search: params.get('q') ?? '',
  }
}
function reviewSearchFromFilters(filters: ReviewFilters): string {
  const params = new URLSearchParams()
  if (filters.sourceIds !== null) {
    if (!filters.sourceIds.length) params.append('source', '')
    else for (const sourceId of filters.sourceIds) params.append('source', sourceId)
  }
  if (filters.projectId) params.set('project', filters.projectId)
  params.set('range', filters.range)
  params.set('status', filters.status)
  if (filters.search) params.set('q', filters.search)
  return `?${params.toString()}`
}

function sameSourceIds(left: string[] | null, right: string[] | null): boolean {
  if (left === right) return true
  if (left === null || right === null || left.length !== right.length) return false
  return left.every((sourceId, index) => sourceId === right[index])
}

function sameReviewFilters(left: ReviewFilters, right: ReviewFilters): boolean {
  return sameSourceIds(left.sourceIds, right.sourceIds)
    && left.projectId === right.projectId
    && left.range === right.range
    && left.status === right.status
    && left.search === right.search
}

export function useReviewUrlSync({
  active,
  model,
  pathname,
  search,
  replace,
  filters,
}: {
  active: boolean
  model: AgentLensClientModel
  pathname: string
  search: string
  replace(pathname: string, search: string): void
  filters: ReviewFilters
}): void {
  const readyRef = useRef(false)
  const pendingUrlFiltersRef = useRef<ReviewFilters | null>(null)

  useEffect(() => {
    if (!active) {
      readyRef.current = false
      pendingUrlFiltersRef.current = null
      return
    }
    if (readyRef.current && !search) return
    const nextFilters = reviewFiltersFromSearch(search)
    readyRef.current = true
    if (!sameReviewFilters(nextFilters, model.getSnapshot().review.filters)) {
      pendingUrlFiltersRef.current = nextFilters
      model.setReviewFilters(nextFilters)
    }
  }, [active, model, search])

  useEffect(() => {
    if (!active || !readyRef.current) return
    // 等到当前渲染真正收到 URL 中的筛选条件后再回写。
    // StrictMode 重放 Effect 或其他状态更新时，跳过一次不足以防止旧筛选覆盖 URL。
    if (pendingUrlFiltersRef.current) {
      if (!sameReviewFilters(filters, pendingUrlFiltersRef.current)) return
      pendingUrlFiltersRef.current = null
    }
    const nextSearch = reviewSearchFromFilters(filters)
    if (search === nextSearch) return
    replace(pathname, nextSearch)
  }, [active, filters, pathname, replace, search])
}
