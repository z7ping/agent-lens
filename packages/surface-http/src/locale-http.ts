import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { validateLocalePack } from '@agent-lens/locale'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type LocalePackFailureDto,
  type LocalePackListResponseDto,
} from '@agent-lens/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeJson } from './http-utils'

const MAX_LOCALE_PACK_BYTES = 1024 * 1024

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
}

export async function discoverLocalePacks(directory?: string): Promise<LocalePackListResponseDto> {
  const items: LocalePackListResponseDto['items'] = []
  const failures: LocalePackFailureDto[] = []
  if (!directory) {
    return {
      items,
      failures,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
    }
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined
    if (code !== 'ENOENT') failures.push({ fileName: basename(directory), message: safeMessage(error) })
    return {
      items,
      failures,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
    const path = join(directory, entry.name)
    try {
      const raw = await readFile(path)
      if (raw.byteLength > MAX_LOCALE_PACK_BYTES) {
        throw new Error(`Locale Pack 超过 ${MAX_LOCALE_PACK_BYTES} 字节限制`)
      }
      const pack = validateLocalePack(JSON.parse(raw.toString('utf8')))
      items.push({
        locale: pack.locale,
        name: pack.name,
        agentLensLocaleVersion: pack.agentLensLocaleVersion,
        messages: { ...pack.messages },
      })
    } catch (error) {
      failures.push({ fileName: entry.name, message: safeMessage(error) })
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name))
  failures.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return {
    items,
    failures,
    meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: new Date().toISOString() },
  }
}

export async function handleLocaleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  directory?: string,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/locales') return false
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  writeJson(response, 200, await discoverLocalePacks(directory))
  return true
}
