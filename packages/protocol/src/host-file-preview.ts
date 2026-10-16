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
  /** 仅由宿主校验并读取的受限图片内容，不返回 file:// 或任意远程地址。 */
  dataUrl?: string
  mimeType?: string
  redacted?: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}
