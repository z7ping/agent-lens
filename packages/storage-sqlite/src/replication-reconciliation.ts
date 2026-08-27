import type {
  KnownReplicationEntityType,
  ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import { SqliteReplicationStateRepository } from './replication-state'

export class SqliteReplicationReconciliationSink implements ReplicationReconciliationSink {
  constructor(private readonly repository: SqliteReplicationStateRepository) {}

  async enqueue(input: Parameters<ReplicationReconciliationSink['enqueue']>[0]): Promise<{ created: boolean; replaced: boolean }> {
    const result = await this.repository.enqueuePending(input)
    return { created: result.created, replaced: result.replaced }
  }

  async getCursor(streamId: string, entityType: KnownReplicationEntityType): Promise<string | undefined> {
    return (await this.repository.getReconciliationCursor(streamId, entityType))?.cursor
  }

  async setCursor(streamId: string, entityType: KnownReplicationEntityType, cursor: string): Promise<void> {
    await this.repository.setReconciliationCursor({
      streamId,
      entityType,
      cursor,
      updatedAt: new Date().toISOString(),
    })
  }
}
