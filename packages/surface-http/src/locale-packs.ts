import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  AGENT_LENS_LOCALE_API_VERSION,
  AGENT_LENS_PROTOCOL_VERSION,
  OFFICIAL_AGENT_LENS_LOCALE,
  parseLocalePackDto,
  type LocalePackListResponseDto,
  type RejectedLocalePackDto,
} from '@agent-lens/protocol'

const MAX_LOCALE_PACK_BYTES = 1024 * 1024

function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

export async function discoverLocalePacks(
  directory: string | undefined,
): Promise<LocalePackListResponseDto> {
  const items: LocalePackListResponseDto['items'] = []
  const rejected: RejectedLocalePackDto[] = []

  if (directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        rejected.push({ fileName: '<directory>', reason: safeReason(error) })
      }
      entries = []
    }

    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue
      try {
        const filePath = join(directory, entry.name)
        const metadata = await stat(filePath)
        if (metadata.size > MAX_LOCALE_PACK_BYTES) {
          throw new Error(`Locale Pack exceeds ${MAX_LOCALE_PACK_BYTES} bytes`)
        }
        const pack = parseLocalePackDto(JSON.parse(await readFile(filePath, 'utf8')))
        if (pack.locale === OFFICIAL_AGENT_LENS_LOCALE) {
          throw new Error('community Locale Pack cannot override official zh-CN')
        }
        if (items.some(item => item.locale === pack.locale)) {
          throw new Error(`duplicate locale: ${pack.locale}`)
        }
        items.push(pack)
      } catch (error) {
        rejected.push({ fileName: entry.name, reason: safeReason(error) })
      }
    }
  }

  return {
    items: items.sort((a, b) => a.locale.localeCompare(b.locale)),
    rejected,
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      localeApiVersion: AGENT_LENS_LOCALE_API_VERSION,
      generatedAt: new Date().toISOString(),
    },
  }
}
