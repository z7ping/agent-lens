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

type StorageWithRuntimeProfiles = StorageService & {
  runtimeProfiles?: RuntimeProfileRepositoryExtension
}

export class RuntimeProfileObservationService implements ObservationService {
  constructor(
    private readonly inner: ObservationService,
    private readonly storage: StorageService,
  ) {}

  async commit(input: CommitObservationInput): Promise<ObservationCommitResult> {
    const result = await this.inner.commit(input)
    const nativeProfileId = input.candidate.identityHints.runtimeProfileNativeId
    const profiles = (this.storage as StorageWithRuntimeProfiles).runtimeProfiles
    if (nativeProfileId && profiles) {
      const profile = await profiles.resolve({
        installationId: input.installation.id,
        nativeProfileId,
      })
      await profiles.attachSession(
        input.sourceId,
        input.installation.id,
        input.candidate.identityHints.nativeSessionId,
        profile.id,
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
    const profiles = (this.storage as StorageWithRuntimeProfiles).runtimeProfiles
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
