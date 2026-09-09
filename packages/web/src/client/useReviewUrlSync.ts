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

function sameReviewFilters(left: ReviewFilters, right: ReviewFilters): boolean {
  return left.sourceIds === right.sourceIds || (left.sourceIds !== null && right.sourceIds !== null
    && left.sourceIds.length === right.sourceIds.length
    && left.sourceIds.every((sourceId, index) => sourceId === right.sourceIds[index]))
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
  const skipWriteRef = useRef(false)

  useEffect(() => {
    if (!active) {
      readyRef.current = false
      skipWriteRef.current = false
      return
    }
    if (readyRef.current && !search) return
    const nextFilters = reviewFiltersFromSearch(search)
    readyRef.current = true
    if (!sameReviewFilters(nextFilters, model.getSnapshot().review.filters)) {
      skipWriteRef.current = true
      model.setReviewFilters(nextFilters)
    }
  }, [active, model, search])

  useEffect(() => {
    if (!active || !readyRef.current) return
    if (skipWriteRef.current) {
      skipWriteRef.current = false
      return
    }
    const nextSearch = reviewSearchFromFilters(filters)
    if (search === nextSearch) return
    replace(pathname, nextSearch)
  }, [active, filters, pathname, replace, search])
}
