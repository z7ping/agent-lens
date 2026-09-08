import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_LOG_BACKUPS = 3

async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return 0
    throw error
  }
}

async function rotate(path, backups) {
  if (backups < 1) {
    await rm(path, { force: true })
    return
  }
  await rm(`${path}.${backups}`, { force: true })
  for (let index = backups - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
  await rename(path, `${path}.1`).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
}

function rotateSync(path, backups) {
  if (backups < 1) {
    rmSync(path, { force: true })
    return
  }
  rmSync(`${path}.${backups}`, { force: true })
  for (let index = backups - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export function appendBoundedLogSync(path, content, {
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  backups = DEFAULT_LOG_BACKUPS,
} = {}) {
  const payload = Buffer.from(String(content))
  mkdirSync(dirname(path), { recursive: true })
  let bytes = 0
  try { bytes = statSync(path).size } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (bytes > 0 && bytes + payload.length > maxBytes) rotateSync(path, backups)
  appendFileSync(path, payload)
}

export async function createRotatingLogWriter(path, {
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  backups = DEFAULT_LOG_BACKUPS,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes 必须是正整数')
  if (!Number.isInteger(backups) || backups < 0) throw new Error('backups 必须是非负整数')

  await mkdir(dirname(path), { recursive: true })
  let bytes = await sizeOf(path)
  let tail = Promise.resolve()

  const write = chunk => {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    tail = tail.then(async () => {
      if (bytes > 0 && bytes + payload.length > maxBytes) {
        await rotate(path, backups)
        bytes = 0
      }
      await appendFile(path, payload)
      bytes += payload.length
    }).catch(() => undefined)
  }

  return { write, flush: () => tail }
}
