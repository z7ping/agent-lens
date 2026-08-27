import { AsyncLocalStorage } from 'node:async_hooks'
import type Database from 'better-sqlite3'

/**
 * Serializes access to one SQLite connection. Transaction callbacks may await
 * repository calls safely: operations in the active transaction bypass the
 * outer queue, while unrelated work waits until COMMIT/ROLLBACK.
 */
export class SqliteExecutor {
  private readonly transactionScope = new AsyncLocalStorage<boolean>()
  private tail: Promise<void> = Promise.resolve()

  constructor(readonly db: Database.Database) {}

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.transactionScope.getStore()) {
      return Promise.resolve(operation())
    }
    return this.enqueue(operation)
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionScope.getStore()) {
      return operation()
    }

    return this.enqueue(async () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = await this.transactionScope.run(true, operation)
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    })
  }

  async close(): Promise<void> {
    await this.tail
    this.db.close()
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
