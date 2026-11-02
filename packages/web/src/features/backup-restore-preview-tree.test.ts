import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackupRestorePreviewItemDto } from '@agent-lens/protocol'
import { buildPreviewTree, filterPreviewTree, previewCount, type PreviewTreeNode } from './backup-restore-preview-tree'

const file = (path: string, status: BackupRestorePreviewItemDto['status'], sourceId = 'codex'): BackupRestorePreviewItemDto => ({
  sourceId, archivePath: `backup/${path.split(/[\\/]/).at(-1)}`, targetPath: path, status, kinds: ['config'],
})
function leafNames(nodes: readonly PreviewTreeNode[]): string[] {
  return nodes.flatMap(node => node.kind === 'file' ? [node.name] : leafNames(node.children))
}

test('Windows, Unix and archive-only paths remain separated without assuming a destination', () => {
  const rows: BackupRestorePreviewItemDto[] = [
    file('C:\\Users\\Demo\\.codex\\AGENTS.md', 'unchanged'),
    file('C:\\Users\\Demo\\.codex\\hooks.json', 'modified'),
    file('/home/demo/.config/config.json', 'missing', 'pi'),
    { sourceId: 'codex', archivePath: 'config/settings.json', kinds: ['config'], status: 'blocked' as const, reason: 'no target' },
  ]
  const roots = buildPreviewTree(rows)
  assert.equal(roots.length, 2)
  assert.equal(roots.reduce((n, root) => n + previewCount(root.counts), 0), 4)
  const codex = roots.find(root => root.sourceId === 'codex')!
  assert.equal(codex.counts.blocked, 1)
  assert.ok(JSON.stringify(codex).includes('@archive'))
  assert.ok(leafNames(roots).includes('AGENTS.md'))
})

test('diff scope hides unchanged paths but preserves ancestry, blocked reasons, and state counts', () => {
  const rows: BackupRestorePreviewItemDto[] = [
    file('C:\\agent\\config\\AGENTS.md', 'unchanged'),
    file('C:\\agent\\config\\hooks.json', 'modified'),
    file('C:\\agent\\data\\missing.txt', 'missing'),
    file('C:\\agent\\data\\conflict.txt', 'blocked'),
  ]
  const roots = buildPreviewTree(rows)
  const changed = filterPreviewTree(roots, 'changes', '')
  assert.deepEqual(leafNames(changed).sort(), ['conflict.txt', 'hooks.json', 'missing.txt'])
  assert.equal(changed[0]!.counts.unchanged, 0)
  assert.equal(changed[0]!.counts.blocked, 1)
  assert.equal(changed[0]!.counts.modified, 1)
  assert.equal(leafNames(filterPreviewTree(roots, 'changes', 'AGENTS.md')).length, 0)
  assert.deepEqual(leafNames(filterPreviewTree(roots, 'all', 'AGENTS.md')), ['AGENTS.md'])
})

test('path search handles Windows separators and status filters without expanding other branches', () => {
  const roots = buildPreviewTree([
    file('C:\\Agent\\Cache\\one.json', 'modified'),
    file('C:\\Agent\\Cache\\two.json', 'blocked'),
    file('C:\\Agent\\Else\\three.json', 'missing'),
    file('/home/demo/cache/four.json', 'modified', 'pi'),
  ])
  assert.deepEqual(leafNames(filterPreviewTree(roots, 'all', 'agent\\cache')).sort(), ['one.json', 'two.json'])
  assert.deepEqual(leafNames(filterPreviewTree(roots, 'all', 'cache', 'blocked')), ['two.json'])
  assert.deepEqual(leafNames(filterPreviewTree(roots, 'changes', 'unknown')), [])
})

test('thousands of unchanged files yield empty default differences and complete optional tree', () => {
  const rows = Array.from({ length: 2495 }, (_, i) => file(`C:\\Agent\\Cache\\entry-${i}.json`, 'unchanged'))
  const roots = buildPreviewTree(rows)
  assert.equal(previewCount(roots[0]!.counts), 2495)
  assert.equal(filterPreviewTree(roots, 'changes', '').length, 0)
  assert.equal(leafNames(filterPreviewTree(roots, 'all', '')).length, 2495)
})


test('shared directory ancestry is compressed into one visible path without dropping leaf evidence', () => {
  const rows = [
    file('C:\\Users\\Demo\\.codex\\plugins\\cache\\entry-one.json', 'modified'),
    file('C:\\Users\\Demo\\.codex\\plugins\\cache\\entry-two.json', 'unchanged'),
  ]
  const roots = filterPreviewTree(buildPreviewTree(rows), 'all', '')
  const source = roots[0]!
  assert.equal(source.children.length, 1)
  const shared = source.children[0]!
  assert.equal(shared.kind, 'directory')
  assert.equal(shared.name, 'C:/Users/Demo/.codex/plugins/cache')
  assert.equal(shared.counts.modified, 1)
  assert.equal(shared.counts.unchanged, 1)
  assert.deepEqual(leafNames([shared]).sort(), ['entry-one.json', 'entry-two.json'])
  assert.equal(shared.children[0]!.kind, 'file')
})

test('different branches stay distinct, and an unresolved archive path remains explicitly marked', () => {
  const rows: BackupRestorePreviewItemDto[] = [
    file('C:\\Users\\Demo\\.codex\\hooks.json', 'modified'),
    file('C:\\Users\\Demo\\.codex\\plugins\\cache\\entry-one.json', 'unchanged'),
    { sourceId: 'codex', archivePath: 'settings/config.json', kinds: ['config'], status: 'blocked', reason: 'target unresolved' },
  ]
  const roots = filterPreviewTree(buildPreviewTree(rows), 'all', '')
  const source = roots[0]!
  const archive = source.children.find(node => node.name === '@archive')
  assert.ok(archive)
  assert.equal(archive.kind, 'directory')
  assert.equal(archive.children[0]!.name, 'settings')
  const host = source.children.find(node => node.kind === 'directory' && node.name.includes('.codex'))
  assert.ok(host)
  assert.equal(host.children.length, 2)
  assert.equal(host.children.find(node => node.kind === 'directory')!.name, 'plugins/cache')
  assert.equal(source.counts.blocked, 1)
})
