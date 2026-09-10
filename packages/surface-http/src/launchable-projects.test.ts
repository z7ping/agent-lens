import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  LaunchableProjectCandidate,
  LaunchableProjectQuery,
  LaunchableProjectReader,
  StorageService,
} from '@agent-lens/core'
import {
  launchableProjectHttpInternals,
  readLaunchableProjects,
} from './launchable-projects'

function candidate(
  key: string,
  lastSeenAt: string,
  workspaces: Array<{ id: string; path: string; lastSeenAt?: string }>,
): LaunchableProjectCandidate {
  return {
    key,
    projectId: key,
    projectName: key,
    lastSeenAt,
    workspaces: workspaces.map(workspace => ({
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      lastSeenAt: workspace.lastSeenAt ?? lastSeenAt,
    })),
  }
}

test('launchable project discovery skips stale workspaces and uses the newest actually launchable cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-launchable-'))
  try {
    const value = await launchableProjectHttpInternals.launchableWorkspace(candidate(
      'agent-lens',
      '2026-09-10T12:00:00.000Z',
      [
        { id: 'stale', path: join(root, 'deleted'), lastSeenAt: '2026-09-10T12:00:00.000Z' },
        { id: 'live', path: root, lastSeenAt: '2026-09-09T12:00:00.000Z' },
      ],
    ))

    assert.equal(value?.workspaceId, 'live')
    assert.equal(value?.workspacePath, root)
    assert.equal(
      value?.lastSeenAt,
      '2026-09-10T12:00:00.000Z',
      'project ordering keeps the server cursor activity time even when the newest historical worktree is stale',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchable project discovery exposes a stable opaque cursor and continues without repeating projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-launchable-page-'))
  const values = [
    candidate('project-c', '2026-09-10T03:00:00.000Z', [{ id: 'wc', path: root }]),
    candidate('project-b', '2026-09-10T02:00:00.000Z', [{ id: 'wb', path: root }]),
    candidate('project-a', '2026-09-10T01:00:00.000Z', [{ id: 'wa', path: root }]),
  ]
  const calls: LaunchableProjectQuery[] = []

  const reader: LaunchableProjectReader = {
    async query(input) {
      calls.push(input)
      const start = input.after
        ? values.findIndex(item => item.key === input.after?.key) + 1
        : 0
      return { items: values.slice(Math.max(0, start)), hasMore: false }
    },
  }
  const storage = { launchableProjects: reader } as StorageService

  try {
    const first = await readLaunchableProjects(storage, new URLSearchParams('limit=2'))
    assert.deepEqual(first.items.map(item => item.key), ['project-c', 'project-b'])
    assert.equal(first.meta.hasMore, true)
    assert.ok(first.meta.nextCursor)

    const second = await readLaunchableProjects(
      storage,
      new URLSearchParams(`limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`),
    )
    assert.deepEqual(second.items.map(item => item.key), ['project-a'])
    assert.equal(second.meta.hasMore, false)
    assert.equal(calls[1]?.after?.key, 'project-b')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('launchable project discovery forwards search to the storage read model and rejects malformed cursors', async () => {
  let search = ''
  const reader: LaunchableProjectReader = {
    async query(input) {
      search = input.search ?? ''
      return { items: [], hasMore: false }
    },
  }
  const storage = { launchableProjects: reader } as StorageService

  const result = await readLaunchableProjects(storage, new URLSearchParams('search=agent-lens&limit=10'))
  assert.equal(search, 'agent-lens')
  assert.deepEqual(result.items, [])

  await assert.rejects(
    readLaunchableProjects(storage, new URLSearchParams('cursor=not-a-valid-cursor')),
    error => Boolean(error && typeof error === 'object' && Reflect.get(error, 'statusCode') === 400),
  )
})
