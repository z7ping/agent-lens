import type {
  AssetBinding,
  AssetBindingHint,
  AssetDefinition,
  AssetDefinitionHint,
  AssetService,
  AssetStateInput,
  AssetStateObservation,
} from '@agent-lens/core'
import type { AgentLensContext } from './context'

export class EventingAssetService implements AssetService {
  constructor(
    private readonly inner: AssetService,
    private readonly ctx: AgentLensContext,
  ) {}

  resolveDefinition(input: AssetDefinitionHint): Promise<AssetDefinition> {
    return this.inner.resolveDefinition(input)
  }

  async resolveBinding(input: AssetBindingHint): Promise<AssetBinding> {
    const binding = await this.inner.resolveBinding(input)
    this.ctx.emit('asset/changed', { assetBindingId: binding.id })
    return binding
  }

  async recordState(input: AssetStateInput): Promise<AssetStateObservation> {
    const state = await this.inner.recordState(input)
    this.ctx.emit('asset/changed', { assetBindingId: state.assetBindingId })
    return state
  }
}
