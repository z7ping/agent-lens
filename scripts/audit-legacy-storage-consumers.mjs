import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Candidate dependencies that must reach ZERO before #617 can close.
 * A hit is an audit lead, NOT proof of an active SQL query.
 */
export const LEGACY_SQL_TABLES = [
  'source_records', 'observations', 'observation_evidence', 'evidence',
  'logical_sessions', 'source_sessions', 'interactions', 'agent_actors',
  'session_summary_projection', 'tool_usage_fact_projection',
  'unknown_observation_projection', 'asset_state_observations',
  'task_file_change_capture', 'task_file_change_projection',
  'native_session_write_claims', 'replication_canonical_changes',
  'replication_frozen_batches', 'hub_remote_replica_entities',
]

export const LEGACY_API_SYMBOLS = [
  '.sourceRecords', '.observationEvidence', '.sessionSummaries',
  '.toolUsageObservations', '.sessionSummaryProjection',
  '.claimLegacyWrite', '.claimNativeOnlyWrite',
]

const EXTENSION = /\.(?:ts|tsx|js|mjs|mts|cts)$/
const IGNORED_DIRS = new Set(['node_modules','dist','.git','coverage','migrations','fixtures'])

async function* walk(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes:true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && EXTENSION.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(entry.name)) yield path
  }
}

export async function auditLegacyStorageConsumers(root) {
  const results = []
  for (const folder of ['packages','apps']) {
    for await (const file of walk(join(root, folder))) {
      const body = await readFile(file, 'utf8')
      const tables = LEGACY_SQL_TABLES.filter(name =>
        new RegExp(`\\b${name}\\b`).test(body))
      const symbols = LEGACY_API_SYMBOLS.filter(name => body.includes(name))
      if (tables.length === 0 && symbols.length === 0) continue
      results.push({
        file: relative(root, file).replaceAll('\\', '/'),
        tables, symbols,
      })
    }
  }
  return results.sort((a,b) => a.file.localeCompare(b.file))
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const results = await auditLegacyStorageConsumers(root)
  const json = process.argv.includes('--json')
  if (json) console.log(JSON.stringify({ count: results.length, results },null,2))
  else {
    console.log(`Legacy SQL/Writer candidate consumers: ${results.length}`)
    for (const result of results) {
      console.log(`- ${result.file}: ${[...result.tables,...result.symbols].join(', ')}`)
    }
  }
  if (process.argv.includes('--require-zero') && results.length > 0) process.exitCode = 1
}
