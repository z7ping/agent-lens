import { createHash } from 'node:crypto'
import type { CanonicalObservation, SourceService, StorageService } from '@agent-lens/core'
import { reviewMessageAttachmentSourcesFromPayload } from '@agent-lens/protocol'
import { asRecord, readJsonlLines } from '@agent-lens/source-support'

/** 只通过已有 Evidence 和 Source Adapter 恢复资源位置，不恢复或返回脱敏前正文。 */
export async function reviewAttachmentSources(
  observation: CanonicalObservation,
  storage: StorageService,
  sources?: SourceService,
) {
  const current = reviewMessageAttachmentSourcesFromPayload(observation.payload)
  if (!observation.nativeEventId) return current
  if (!current.some(item => item.attachment.type === 'image' && item.localPath?.includes('[用户]'))) return current
  const evidence = (await storage.repositories.evidence.listForObservation(observation.id)).slice(0, 8)
  for (const item of evidence) {
    if (!item.sourceRecordId) continue
    const record = await storage.repositories.sourceRecords.get(item.sourceRecordId)
    const definition = record ? sources?.list().find(value => value.manifest.sourceId === record.sourceId) : null
    if (!record || !definition?.rawRecovery?.verify || !record.fingerprint || record.locator.kind !== 'file'
      || !record.locator.path || record.locator.offset === undefined
      || !definition.rawRecovery.describe(record).canReread
      || !definition.rawRecovery.describe(record).canReparse) continue
    try {
      if ((await definition.rawRecovery.verify(record)).state !== 'verified') continue
      const [host, installation] = await Promise.all([
        storage.repositories.hosts.get(observation.hostId),
        storage.repositories.installations.get(observation.installationId),
      ])
      if (!host || !installation) continue
      for await (const line of readJsonlLines(record.locator.path, record.locator.offset)) {
        if (line.startOffset !== record.locator.offset || line.text.length > 2 * 1024 * 1024
          || createHash('sha256').update(line.text).digest('hex') !== record.fingerprint) break
        const recovered = await definition.normalize({
          ...record, payload: { ...asRecord(record.payload), entry: JSON.parse(line.text) },
        }, { host, installation })
        const candidate = recovered.observations.find(value => value.kind === observation.kind
          && value.nativeEventId === observation.nativeEventId)
        if (!candidate) break
        const nativeSources = reviewMessageAttachmentSourcesFromPayload(candidate.payload)
        if (nativeSources.length !== current.length) break
        return current.map((value, index) => {
          const native = nativeSources[index]
          return native?.localPath && native.attachment.type === value.attachment.type
            && native.attachment.name === value.attachment.name
            ? { ...value, localPath: native.localPath } : value
        })
      }
    } catch {
      // 原始记录丢失或变更时保留当前附件元信息。
    }
  }
  return current
}
