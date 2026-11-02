import type { BackupRestorePreviewItemDto } from '@agent-lens/protocol'

export type PreviewFileStatus = BackupRestorePreviewItemDto['status']
export type PreviewTreeScope = 'changes' | 'all'
export type PreviewStatusCounts = Record<PreviewFileStatus, number>

export interface PreviewTreeNode {
  id: string
  name: string
  path: string
  sourceId: string
  kind: 'source' | 'directory' | 'file'
  counts: PreviewStatusCounts
  children: PreviewTreeNode[]
  item?: BackupRestorePreviewItemDto
}

export function previewCount(counts: PreviewStatusCounts): number {
  return counts.unchanged + counts.missing + counts.modified + counts.blocked
}

function blankCounts(): PreviewStatusCounts {
  return { blocked: 0, modified: 0, missing: 0, unchanged: 0 }
}

function increment(counts: PreviewStatusCounts, status: PreviewFileStatus): void {
  counts[status] += 1
}

function merge(counts: PreviewStatusCounts, additional: PreviewStatusCounts): void {
  counts.blocked += additional.blocked
  counts.modified += additional.modified
  counts.missing += additional.missing
  counts.unchanged += additional.unchanged
}

function priority(node: PreviewTreeNode): number {
  return node.counts.blocked ? 0 : node.counts.modified ? 1 : node.counts.missing ? 2 : 3
}

function sortTree(node: PreviewTreeNode): void {
  node.children.sort((a, b) => priority(a) - priority(b)
    || (a.kind === 'file' ? 1 : 0) - (b.kind === 'file' ? 1 : 0)
    || a.name.localeCompare(b.name))
  for (const child of node.children) if (child.kind !== 'file') sortTree(child)
}

/** Build a destination tree, keeping archive-only paths separate from resolvable targets. */
export function buildPreviewTree(items: readonly BackupRestorePreviewItemDto[]): PreviewTreeNode[] {
  const sources = new Map<string, PreviewTreeNode>()
  const directories = new Map<string, PreviewTreeNode>()

  items.forEach((item, index) => {
    let root = sources.get(item.sourceId)
    if (!root) {
      root = { id: `source:${item.sourceId}`, name: item.sourceId, path: '', sourceId: item.sourceId,
        kind: 'source', counts: blankCounts(), children: [] }
      sources.set(item.sourceId, root)
    }
    increment(root.counts, item.status)
    const hasTarget = Boolean(item.targetPath)
    const originalPath = item.targetPath || item.archivePath
    const normalized = originalPath.replace(/\\/g, '/')
    const segments = normalized.split('/').filter(Boolean)
    // A separate group prevents an archive fallback from implying a verified destination.
    if (!hasTarget) segments.unshift('@archive')
    else if (normalized.startsWith('//')) segments.unshift('@network')
    else if (normalized.startsWith('/')) segments.unshift('/')
    if (!segments.length) segments.push(item.archivePath || String(index))

    let parent = root
    let prefix = ''
    for (const segment of segments.slice(0, -1)) {
      prefix += `/${segment}`
      const id = `${root.id}:${hasTarget ? 'target' : 'archive'}:${prefix}`
      let directory = directories.get(id)
      if (!directory) {
        directory = { id, name: segment, path: prefix, sourceId: item.sourceId,
          kind: 'directory', counts: blankCounts(), children: [] }
        directories.set(id, directory)
        parent.children.push(directory)
      }
      increment(directory.counts, item.status)
      parent = directory
    }
    parent.children.push({
      id: `${root.id}:file:${index}`, name: segments[segments.length - 1]!,
      path: originalPath, sourceId: item.sourceId, kind: 'file',
      counts: { ...blankCounts(), [item.status]: 1 }, children: [], item,
    })
  })
  const roots = [...sources.values()]
  roots.forEach(sortTree)
  return roots.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name))
}

/** Keep only matching file leaves and the necessary ancestor folders; never fabricate file states. */
export function filterPreviewTree(
  roots: readonly PreviewTreeNode[],
  scope: PreviewTreeScope,
  query: string,
  status: PreviewFileStatus | 'all' = 'all',
): PreviewTreeNode[] {
  const needle = query.trim().replace(/\\/g, '/').toLocaleLowerCase()
  function visit(node: PreviewTreeNode): PreviewTreeNode | null {
    if (node.kind === 'file') {
      const item = node.item!
      if (scope === 'changes' && item.status === 'unchanged') return null
      if (status !== 'all' && item.status !== status) return null
      if (needle && !`${item.sourceId}/${node.path}`.replace(/\\/g, '/').toLocaleLowerCase().includes(needle)) return null
      return node
    }
    const children = node.children.map(visit).filter((child): child is PreviewTreeNode => child !== null)
    if (!children.length) return null
    const counts = blankCounts()
    children.forEach(child => merge(counts, child.counts))
    return { ...node, children, counts }
  }
  return roots.map(visit).filter((node): node is PreviewTreeNode => node !== null)
    .map(compactPreviewPaths)
}

/**
 * Collapse directory-only chains into one visible path. The last directory
 * retains its stable ID and destination path; file evidence stays unchanged.
 * Special archive/network roots remain explicit so users never confuse an
 * unresolved archive path with a verified restore destination.
 */
export function compactPreviewPaths(node: PreviewTreeNode): PreviewTreeNode {
  if (node.kind === 'file') return node
  let current: PreviewTreeNode = {
    ...node,
    children: node.children.map(compactPreviewPaths),
  }
  while (
    current.kind === 'directory' &&
    !['@archive', '@network'].includes(current.name) &&
    current.children.length === 1 &&
    current.children[0]?.kind === 'directory' &&
    !['@archive', '@network'].includes(current.children[0].name)
  ) {
    const child = current.children[0]!
    current = {
      ...child,
      name: current.name === '/' ? `/${child.name}` : `${current.name}/${child.name}`,
    }
  }
  return current
}
