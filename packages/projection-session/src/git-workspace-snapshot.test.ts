import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  captureGitWorkspaceSnapshot,
  diffGitWorkspaceSnapshot,
} from './git-workspace-snapshot'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]) {
  await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

async function withRepo(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-task-git-'))
  try {
    await git(root, 'init')
    await git(root, 'config', 'user.email', 'agent-lens@example.invalid')
    await git(root, 'config', 'user.name', 'AgentLens Test')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('Git workspace baseline excludes dirty state that existed before the task', async () => {
  await withRepo(async root => {
    await writeFile(join(root, 'tracked.txt'), 'base\n', 'utf8')
    await git(root, 'add', 'tracked.txt')
    await git(root, 'commit', '-m', 'initial')

    // Existing user change before Agent task begins.
    await writeFile(join(root, 'tracked.txt'), 'base\npreexisting\n', 'utf8')
    await writeFile(join(root, 'existing-untracked.txt'), 'before\n', 'utf8')

    const baseline = await captureGitWorkspaceSnapshot(root)
    assert.ok(baseline)

    // Agent changes one already-dirty file and creates one file.
    await writeFile(join(root, 'tracked.txt'), 'base\npreexisting\nagent\n', 'utf8')
    await writeFile(join(root, 'new.txt'), 'created\n', 'utf8')

    const changes = await diffGitWorkspaceSnapshot(baseline!)
    assert.deepEqual(changes, [
      {
        path: 'new.txt',
        changeType: 'added',
        additions: 1,
        deletions: 0,
      },
      {
        path: 'tracked.txt',
        changeType: 'modified',
        additions: 1,
        deletions: 0,
      },
    ])
  })
})

test('Git workspace baseline preserves changes even if the Agent commits them', async () => {
  await withRepo(async root => {
    await writeFile(join(root, 'a.txt'), 'a\n', 'utf8')
    await git(root, 'add', 'a.txt')
    await git(root, 'commit', '-m', 'initial')

    const baseline = await captureGitWorkspaceSnapshot(root)
    assert.ok(baseline)

    await writeFile(join(root, 'a.txt'), 'a\nb\n', 'utf8')
    await git(root, 'add', 'a.txt')
    await git(root, 'commit', '-m', 'agent change')

    const changes = await diffGitWorkspaceSnapshot(baseline!)
    assert.deepEqual(changes, [{
      path: 'a.txt',
      changeType: 'modified',
      additions: 1,
      deletions: 0,
    }])
  })
})

test('Git workspace baseline detects rename and delete against the task-start tree', async () => {
  await withRepo(async root => {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'old.ts'), 'export const value = 1\n', 'utf8')
    await writeFile(join(root, 'delete.ts'), 'remove me\n', 'utf8')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'initial')

    const baseline = await captureGitWorkspaceSnapshot(root)
    assert.ok(baseline)

    await git(root, 'mv', 'src/old.ts', 'src/new.ts')
    await rm(join(root, 'delete.ts'))

    const changes = await diffGitWorkspaceSnapshot(baseline!)
    assert.deepEqual(changes, [
      {
        path: 'delete.ts',
        changeType: 'deleted',
        additions: 0,
        deletions: 1,
      },
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        changeType: 'renamed',
        additions: 0,
        deletions: 0,
      },
    ])
  })
})
