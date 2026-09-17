import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type {
  CommitObservationInput,
  IdentityService,
  LogicalSession,
  LogicalSessionIdentityHint,
  ObservationCommitResult,
  SourceSession,
  SourceSessionIdentityHint,
  StorageService,
} from '@agent-lens/core'
import {
  DefaultIdentityService as LegacyIdentityService,
  DefaultObservationService as LegacyObservationService,
} from './index'

function stableId(prefix: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
  return `${prefix}-${digest}`
}

/**
 * RuntimeProfile-aware default identity while preserving legacy ids for sources
 * that do not expose profiles.
 */
export class DefaultIdentityService extends LegacyIdentityService {
  constructor(private readonly profileStorage: StorageService) {
    super(profileStorage)
  }

  override async resolveLogicalSession(hint: LogicalSessionIdentityHint): Promise<LogicalSession> {
    if (!hint.runtimeProfileId) return super.resolveLogicalSession(hint)

    const repository = this.profileStorage.repositories.sessions
    const scopedId = stableId('session', [
      hint.installationId,
      hint.runtimeProfileId,
      hint.nativeSessionId,
    ])
    const legacyId = stableId('session', [hint.installationId, hint.nativeSessionId])
    const scopedExisting = await repository.getLogicalSession(scopedId)
    const legacyExisting = scopedExisting ? null : await repository.getLogicalSession(legacyId)
    const existing = scopedExisting
      ?? (legacyExisting?.runtimeProfileId === hint.runtimeProfileId ? legacyExisting : null)
    const session: LogicalSession = {
      id: existing?.id ?? scopedId,
      installationId: hint.installationId,
      runtimeProfileId: hint.runtimeProfileId,
      ...(hint.projectId ?? existing?.projectId ? { projectId: hint.projectId ?? existing!.projectId } : {}),
      ...(hint.workspaceId ?? existing?.workspaceId ? { workspaceId: hint.workspaceId ?? existing!.workspaceId } : {}),
      ...(hint.title ?? existing?.title ? { title: hint.title ?? existing!.title } : {}),
      ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
      ...(existing?.endedAt ? { endedAt: existing.endedAt } : {}),
    }
    await repository.putLogicalSession(session)
    return session
  }

  override async resolveSourceSession(hint: SourceSessionIdentityHint): Promise<SourceSession> {
    if (!hint.runtimeProfileId) return super.resolveSourceSession(hint)

    const repository = this.profileStorage.repositories.sessions
    const scopedId = stableId('source-session', [
      hint.sourceId,
      hint.installationId,
      hint.runtimeProfileId,
      hint.nativeSessionId,
    ])
    const legacyId = stableId('source-session', [
      hint.sourceId,
      hint.installationId,
      hint.nativeSessionId,
    ])
    const scopedExisting = await repository.getSourceSession(scopedId)
    const legacyExisting = scopedExisting ? null : await repository.getSourceSession(legacyId)
    const existing = scopedExisting
      ?? (legacyExisting?.runtimeProfileId === hint.runtimeProfileId ? legacyExisting : null)
    const session: SourceSession = existing ?? {
      id: scopedId,
      sourceId: hint.sourceId,
      installationId: hint.installationId,
      runtimeProfileId: hint.runtimeProfileId,
      nativeSessionId: hint.nativeSessionId,
    }
    const resolved: SourceSession = {
      ...session,
      runtimeProfileId: hint.runtimeProfileId,
      ...(hint.logicalSessionId ? { logicalSessionId: hint.logicalSessionId } : {}),
      ...(hint.nativeParentSessionId ? { nativeParentSessionId: hint.nativeParentSessionId } : {}),
    }
    await repository.putSourceSession(resolved)
    return resolved
  }
}

interface RuntimeProfileScope {
  runtimeProfileId?: string
}

function scopedIdentity(
  identity: IdentityService,
  scope: AsyncLocalStorage<RuntimeProfileScope>,
): IdentityService {
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'resolveLogicalSession') {
        return (hint: LogicalSessionIdentityHint) => target.resolveLogicalSession({
          ...hint,
          ...(scope.getStore()?.runtimeProfileId
            ? { runtimeProfileId: scope.getStore()!.runtimeProfileId }
            : {}),
        })
      }
      if (property === 'resolveSourceSession') {
        return (hint: SourceSessionIdentityHint) => target.resolveSourceSession({
          ...hint,
          ...(scope.getStore()?.runtimeProfileId
            ? { runtimeProfileId: scope.getStore()!.runtimeProfileId }
            : {}),
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * Resolves the native RuntimeProfile before the legacy observation commit path
 * enters session identity resolution. The rest of commit/dedup stays shared.
 */
export class DefaultObservationService extends LegacyObservationService {
  private readonly runtimeProfileScope: AsyncLocalStorage<RuntimeProfileScope>

  constructor(
    private readonly profileStorage: StorageService,
    identity: IdentityService,
  ) {
    const scope = new AsyncLocalStorage<RuntimeProfileScope>()
    super(profileStorage, scopedIdentity(identity, scope))
    this.runtimeProfileScope = scope
  }

  override async commit(input: CommitObservationInput): Promise<ObservationCommitResult> {
    const nativeProfileId = input.candidate.identityHints.runtimeProfileNativeId
    const runtimeProfiles = this.profileStorage.runtimeProfiles
    if (!nativeProfileId || !runtimeProfiles) return super.commit(input)

    const profile = await runtimeProfiles.resolve({
      installationId: input.installation.id,
      nativeProfileId,
    })
    return this.runtimeProfileScope.run(
      { runtimeProfileId: profile.id },
      () => super.commit(input),
    )
  }
}
