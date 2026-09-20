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
  workspaces: Array<{
    id: string
    path: string
    lastSeenAt?: string
    validationStatus?: 'unknown' | 'valid' | 'invalid'
    validatedAt?: string
  }>,
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
      ...(workspace.validationStatus ? { validationStatus: workspace.validationStatus } : {}),
      ...(workspace.validatedAt ? { validatedAt: workspace.validatedAt } : {}),
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


test('launchable project discovery validates one bounded candidate page with limited concurrency', async () => {
  const candidates = Array.from({ length: 40 }, (_, index) =>
    candidate(
      `project-${String(index).padStart(2, '0')}`,
      `2026-09-10T${String(23 - Math.floor(index / 2)).padStart(2, '0')}:00:00.000Z`,
      [{ id: `workspace-${index}`, path: `/workspace/project-${index}` }],
    ))
  let queries = 0
  let active = 0
  let maxActive = 0
  const reader: LaunchableProjectReader = {
    async query(input) {
      queries += 1
      assert.equal(input.limit, 40)
      return { items: candidates, hasMore: true }
    },
  }
  const storage = { launchableProjects: reader } as StorageService
  const validate = async (path: string) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active -= 1
    return path
  }

  const result = await readLaunchableProjects(storage, new URLSearchParams('limit=20'), validate)

  assert.equal(queries, 1, 'first response must not keep fetching candidate pages to fill 20 rows')
  assert.equal(result.items.length, 20)
  assert.ok(maxActive > 1, 'filesystem validation should no longer be globally serial')
  assert.ok(maxActive <= launchableProjectHttpInternals.VALIDATION_CONCURRENCY)
  assert.equal(result.meta.hasMore, true)
  assert.ok(result.meta.nextCursor)
})


test('launchable project discovery returns a fresh valid cached workspace without filesystem IO', async () => {
  const now = Date.parse('2026-09-20T00:00:00.000Z')
  let validations = 0
  const value = await launchableProjectHttpInternals.launchableWorkspace(
    candidate('cached-project', '2026-09-20T00:00:00.000Z', [{
      id: 'cached-workspace',
      path: '/workspace/cached',
      validationStatus: 'valid',
      validatedAt: new Date(now - 5_000).toISOString(),
    }]),
    async path => {
      validations += 1
      return path
    },
    undefined,
    now,
  )

  assert.equal(value?.workspacePath, '/workspace/cached')
  assert.equal(validations, 0)
})

test('launchable project discovery skips a fresh invalid cached workspace without filesystem IO', async () => {
  const now = Date.parse('2026-09-20T00:00:00.000Z')
  let validations = 0
  const value = await launchableProjectHttpInternals.launchableWorkspace(
    candidate('cached-project', '2026-09-20T00:00:00.000Z', [
      {
        id: 'invalid-workspace',
        path: '/workspace/invalid',
        validationStatus: 'invalid',
        validatedAt: new Date(now - 5_000).toISOString(),
      },
      {
        id: 'unknown-workspace',
        path: '/workspace/current',
      },
    ]),
    async path => {
      validations += 1
      return path
    },
    undefined,
    now,
  )

  assert.equal(value?.workspaceId, 'unknown-workspace')
  assert.equal(validations, 1)
})

test('launchable project discovery records unknown workspace validation for later cache hits', async () => {
  const records: Array<{ workspaceId: string; workspacePath: string; status: 'valid' | 'invalid'; validatedAt: string }> = []
  const values = [
    candidate('recorded-project', '2026-09-20T00:00:00.000Z', [{
      id: 'recorded-workspace',
      path: '/workspace/recorded',
    }]),
  ]
  const reader: LaunchableProjectReader = {
    async query() {
      return { items: values, hasMore: false }
    },
    async recordWorkspaceValidation(input) {
      records.push(input)
    },
  }

  const result = await readLaunchableProjects(
    { launchableProjects: reader } as StorageService,
    new URLSearchParams('limit=20'),
    async path => path,
  )
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(result.items[0]?.workspaceId, 'recorded-workspace')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.status, 'valid')
})
