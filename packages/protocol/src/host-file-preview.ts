import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'
import type {
  ManagedAssetPreviewBlockedReason,
  ManagedAssetPreviewStatus,
} from './managed-assets'

export interface HostFilePreviewResponseDto {
  path: string
  name: string
  kind: 'file'
  size: number
  modifiedAt: string
  previewStatus: ManagedAssetPreviewStatus
  blockedReason?: ManagedAssetPreviewBlockedReason
  content?: string
  redacted?: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}
