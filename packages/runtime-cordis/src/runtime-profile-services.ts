import type {
  AssetBinding,
  AssetBindingHint,
  AssetDefinition,
  AssetDefinitionHint,
  AssetService,
  AssetStateInput,
  AssetStateObservation,
  CanonicalObservation,
  CommitObservationInput,
  ObservationCommitResult,
  ObservationQuery,
  ObservationService,
  RuntimeProfile,
  StorageService,
} from '@agent-lens/core'

interface RuntimeProfileRepositoryExtension {
  resolve(hint: {
    installationId: string
    nativeProfileId: string
  }): Promise<RuntimeProfile>
  attachSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
    runtimeProfileId: string,
  ): Promise<void>
  attachAssetBinding(assetBindingId: string, runtimeProfileId: string): Promise<void>
}

interface SessionRelationshipCandidateRepositoryExtension {
  tryPromoteForSession(
    sourceId: string,
    installationId: string,
    nativeSessionId: string,
  ): Promise<number>
}

type StorageWithRuntimeExtensions = StorageService & {
  runtimeProfiles?: RuntimeProfileRepositoryExtension
  sessionRelationshipCandidates?: SessionRelationshipCandidateRepositoryExtension
}

export class RuntimeProfileObservationService implements ObservationService {
  constructor(
    private readonly inner: ObservationService,
    private readonly storage: StorageService,
  ) {}

  async commit(input: CommitObservationInput): Promise<ObservationCommitResult> {
    const result = await this.inner.commit(input)
    const extensions = this.storage as StorageWithRuntimeExtensions
    const nativeProfileId = input.candidate.identityHints.runtimeProfileNativeId
    if (nativeProfileId && extensions.runtimeProfiles) {
      const profile = await extensions.runtimeProfiles.resolve({
        installationId: input.installation.id,
        nativeProfileId,
      })
      await extensions.runtimeProfiles.attachSession(
        input.sourceId,
        input.installation.id,
        input.candidate.identityHints.nativeSessionId,
        profile.id,
      )
    }

    const shouldRetryRelationships = input.candidate.kind === 'session.lifecycle'
      || Boolean(input.candidate.identityHints.nativeParentSessionId)
    if (shouldRetryRelationships && extensions.sessionRelationshipCandidates) {
      await extensions.sessionRelationshipCandidates.tryPromoteForSession(
        input.sourceId,
        input.installation.id,
        input.candidate.identityHints.nativeSessionId,
      )
    }
    return result
  }

  get(id: string): Promise<CanonicalObservation | null> {
    return this.inner.get(id)
  }

  query(query: ObservationQuery): Promise<CanonicalObservation[]> {
    return this.inner.query(query)
  }
}

export class RuntimeProfileAssetService implements AssetService {
  constructor(
    private readonly inner: AssetService,
    private readonly storage: StorageService,
  ) {}

  resolveDefinition(input: AssetDefinitionHint): Promise<AssetDefinition> {
    return this.inner.resolveDefinition(input)
  }

  async resolveBinding(input: AssetBindingHint): Promise<AssetBinding> {
    const binding = await this.inner.resolveBinding(input)
    const profiles = (this.storage as StorageWithRuntimeExtensions).runtimeProfiles
    if (input.runtimeProfileId && profiles) {
      await profiles.attachAssetBinding(binding.id, input.runtimeProfileId)
    }
    return input.runtimeProfileId
      ? { ...binding, runtimeProfileId: input.runtimeProfileId }
      : binding
  }

  recordState(input: AssetStateInput): Promise<AssetStateObservation> {
    return this.inner.recordState(input)
  }
}
