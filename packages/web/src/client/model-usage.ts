import { AgentLensReviewModel } from './model-review'

export class AgentLensClientModel extends AgentLensReviewModel {
  async refreshUsage(): Promise<void> {
    const generation = ++this.usageGeneration
    const invalidation = this.usageInvalidation
    const current = this.snapshot.usage
    this.publish({
      ...this.snapshot,
      usage: { ...current, loading: true, error: '' },
    })
    try {
      const response = await this.api.usage(current.filters)
      if (generation !== this.usageGeneration) return
      this.publish({
        ...this.snapshot,
        usage: {
          ...this.snapshot.usage,
          response,
          loading: false,
          hasNewData: this.usageInvalidation !== invalidation,
          error: '',
        },
      })
    } catch (error) {
      if (generation !== this.usageGeneration) return
      this.publish({
        ...this.snapshot,
        usage: {
          ...this.snapshot.usage,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

}
