import { AsyncLocalStorage } from 'node:async_hooks'
import type Database from 'better-sqlite3'

const SAMPLE_LIMIT = 256

function percentile(samples: readonly number[], ratio: number): number {
  if (!samples.length) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

function pushSample(samples: number[], value: number): void {
  samples.push(value)
  if (samples.length > SAMPLE_LIMIT) samples.shift()
}

export interface SqliteExecutorMetrics {
  enqueued: number
  completed: number
  active: number
  queueDepth: number
  maxQueueDepth: number
  queueWaitMs: { last: number; max: number; p50: number; p95: number; p99: number }
  executionMs: { last: number; max: number; p50: number; p95: number; p99: number }
  transactionMs: { count: number; last: number; max: number; p50: number; p95: number; p99: number }
}

/**
 * Serializes access to one SQLite connection. Transaction callbacks may await
 * repository calls safely. An RPC owner may also hold an external transaction
 * across several worker messages; while that owner is active nested repository
 * transactions reuse the existing BEGIN/COMMIT boundary.
 */
export class SqliteExecutor {
  private readonly transactionScope = new AsyncLocalStorage<boolean>()
  private tail: Promise<void> = Promise.resolve()
  private externalTransaction = false
  private externalTransactionStartedAt = 0
  private enqueued = 0
  private completed = 0
  private active = 0
  private queueDepth = 0
  private maxQueueDepth = 0
  private lastQueueWaitMs = 0
  private maxQueueWaitMs = 0
  private lastExecutionMs = 0
  private maxExecutionMs = 0
  private transactionCount = 0
  private lastTransactionMs = 0
  private maxTransactionMs = 0
  private readonly queueWaitSamples: number[] = []
  private readonly executionSamples: number[] = []
  private readonly transactionSamples: number[] = []

  constructor(readonly db: Database.Database) {}

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionScope.getStore() || this.externalTransaction) {
      return this.measureDirect(operation)
    }
    return this.enqueue(operation)
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionScope.getStore() || this.externalTransaction) {
      return operation()
    }

    return this.enqueue(async () => {
      const startedAt = performance.now()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = await this.transactionScope.run(true, operation)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      } finally {
        this.recordTransaction(performance.now() - startedAt)
      }
    })
  }

  async beginExternalTransaction(): Promise<void> {
    if (this.externalTransaction) throw new Error('SQLite external transaction is already active')
    await this.enqueue(() => {
      if (this.externalTransaction) throw new Error('SQLite external transaction is already active')
      this.db.exec('BEGIN IMMEDIATE')
      this.externalTransaction = true
      this.externalTransactionStartedAt = performance.now()
    })
  }

  commitExternalTransaction(): void {
    if (!this.externalTransaction) throw new Error('SQLite external transaction is not active')
    try {
      this.db.exec('COMMIT')
    } finally {
      this.finishExternalTransaction()
    }
  }

  rollbackExternalTransaction(): void {
    if (!this.externalTransaction) return
    try {
      this.db.exec('ROLLBACK')
    } finally {
      this.finishExternalTransaction()
    }
  }

  hasExternalTransaction(): boolean {
    return this.externalTransaction
  }

  metrics(): SqliteExecutorMetrics {
    return {
      enqueued: this.enqueued,
      completed: this.completed,
      active: this.active,
      queueDepth: this.queueDepth,
      maxQueueDepth: this.maxQueueDepth,
      queueWaitMs: {
        last: this.lastQueueWaitMs,
        max: this.maxQueueWaitMs,
        p50: percentile(this.queueWaitSamples, 0.5),
        p95: percentile(this.queueWaitSamples, 0.95),
        p99: percentile(this.queueWaitSamples, 0.99),
      },
      executionMs: {
        last: this.lastExecutionMs,
        max: this.maxExecutionMs,
        p50: percentile(this.executionSamples, 0.5),
        p95: percentile(this.executionSamples, 0.95),
        p99: percentile(this.executionSamples, 0.99),
      },
      transactionMs: {
        count: this.transactionCount,
        last: this.lastTransactionMs,
        max: this.maxTransactionMs,
        p50: percentile(this.transactionSamples, 0.5),
        p95: percentile(this.transactionSamples, 0.95),
        p99: percentile(this.transactionSamples, 0.99),
      },
    }
  }

  async close(): Promise<void> {
    await this.tail
    if (this.externalTransaction) this.rollbackExternalTransaction()
    this.db.close()
  }

  private finishExternalTransaction(): void {
    const duration = this.externalTransactionStartedAt > 0
      ? performance.now() - this.externalTransactionStartedAt
      : 0
    this.externalTransaction = false
    this.externalTransactionStartedAt = 0
    this.recordTransaction(duration)
  }

  private recordTransaction(duration: number): void {
    this.transactionCount += 1
    this.lastTransactionMs = duration
    this.maxTransactionMs = Math.max(this.maxTransactionMs, duration)
    pushSample(this.transactionSamples, duration)
  }

  private async measureDirect<T>(operation: () => T | Promise<T>): Promise<T> {
    this.active += 1
    const startedAt = performance.now()
    try {
      return await operation()
    } finally {
      const duration = performance.now() - startedAt
      this.lastExecutionMs = duration
      this.maxExecutionMs = Math.max(this.maxExecutionMs, duration)
      pushSample(this.executionSamples, duration)
      this.active = Math.max(0, this.active - 1)
      this.completed += 1
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const queuedAt = performance.now()
    this.enqueued += 1
    this.queueDepth += 1
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queueDepth)

    const execute = async (): Promise<T> => {
      this.queueDepth = Math.max(0, this.queueDepth - 1)
      this.active += 1
      const queueWait = performance.now() - queuedAt
      this.lastQueueWaitMs = queueWait
      this.maxQueueWaitMs = Math.max(this.maxQueueWaitMs, queueWait)
      pushSample(this.queueWaitSamples, queueWait)

      const startedAt = performance.now()
      try {
        return await operation()
      } finally {
        const duration = performance.now() - startedAt
        this.lastExecutionMs = duration
        this.maxExecutionMs = Math.max(this.maxExecutionMs, duration)
        pushSample(this.executionSamples, duration)
        this.active = Math.max(0, this.active - 1)
        this.completed += 1
      }
    }

    const result = this.tail.then(execute, execute)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export const sqliteExecutorInternals = {
  percentile,
  SAMPLE_LIMIT,
}
