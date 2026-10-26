/** Native-only public runtime surface. Never re-export the v38 storage
 * provider, event repositories, replication, Writer Claims or migrations.
 * The one-time offline migrator continues to use explicit legacy readers.
 */
export { SqliteSlimStorage } from './slim-storage'
export { readActiveDatabasePointer, type ActiveDatabasePointer } from './slim-active-pointer'
