import type {
  PiLivePackageUpdate,
  PiLivePackageUpdateCheckStatus,
  PiLiveStartupResources,
} from './types'

export interface PiLiveStartupAuditSnapshot {
  runtimeSessionId: string
  attemptStartedAt: string
  attemptGeneration?: number | undefined
  capturedAt: string
  nativeSessionId: string
  workspacePath: string
  startupResources: PiLiveStartupResources
  packageUpdateCheck?: Exclude<PiLivePackageUpdateCheckStatus, 'checking'> | undefined
  packageUpdates?: PiLivePackageUpdate[] | undefined
  packageUpdatesCheckedAt?: string | undefined
  piVersionCheck?: 'complete' | 'unavailable' | 'failed' | undefined
  piLatestVersion?: string | undefined
  piVersionCheckedAt?: string | undefined
  executable?: string | undefined
  sdkVersion?: string | undefined
  sessionName?: string | undefined
}

export interface PiLiveStartupAuditSink {
  recordStartupAudit(snapshot: PiLiveStartupAuditSnapshot): Promise<void>
}
