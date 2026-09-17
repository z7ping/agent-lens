import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeStorageBudgetUsage,
  type StorageBudgetPolicy,
} from '@agent-lens/core'

export interface DirectoryFootprint {
  state: 'present' | 'not-created' | 'unavailable'
  bytes: number
  files: number
  directories: number
  ignoredEntries: number
  error?: string
}

async function directoryFootprint(path: string): Promise<DirectoryFootprint> {
  let bytes = 0
  let files = 0
  let directories = 0
  let ignoredEntries = 0
  const pending = [path]

  try {
    while (pending.length) {
      const current = pending.pop()!
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (current === path) {
            return {
              state: 'not-created',
              bytes: 0,
              files: 0,
              directories: 0,
              ignoredEntries: 0,
            }
          }
          // Inbox producers/consumers may remove a directory while diagnostics walks it.
          continue
        }
        throw error
      }

      directories += 1
      for (const entry of entries) {
        const entryPath = join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(entryPath)
          continue
        }
        if (entry.isFile()) {
          try {
            const file = await stat(entryPath)
            bytes += file.size
            files += 1
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
          continue
        }
        // Never follow symlinks or other special filesystem entries while diagnosing size.
        ignoredEntries += 1
      }
    }
    return { state: 'present', bytes, files, directories, ignoredEntries }
  } catch (error) {
    return {
      state: 'unavailable',
      bytes,
      files,
      directories,
      ignoredEntries,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function readRuntimeStorageFootprint(dataRoot: string, budget?: StorageBudgetPolicy) {
  const [total, inbox, temp, content] = await Promise.all([
    directoryFootprint(dataRoot),
    directoryFootprint(join(dataRoot, 'inbox')),
    directoryFootprint(join(dataRoot, 'temp')),
    directoryFootprint(join(dataRoot, 'content')),
  ])
  return {
    basis: 'agent-lens-data-root-filesystem',
    total: {
      ...total,
      ...(budget && total.state !== 'unavailable'
        ? {
            capacity: {
              ...describeStorageBudgetUsage(total.bytes, budget.total),
              preset: budget.preset,
              scope: 'total-data-root',
            },
          }
        : {}),
    },
    inbox,
    temp,
    content,
  }
}
