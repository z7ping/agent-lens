import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditLegacyStorageConsumers } from './audit-legacy-storage-consumers.mjs'

test('legacy cutover audit lists source-wide production dependencies, not tests or schema DDL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-storage-audit-'))
  try {
    await mkdir(join(root,'packages','test-package','src'),{recursive:true})
    await mkdir(join(root,'apps','daemon','src'),{recursive:true})
    await mkdir(join(root,'packages','test-package','migrations'),{recursive:true})
    await writeFile(join(root,'packages','test-package','src','old.ts'),
      `const sql = "SELECT * FROM source_records JOIN observations ON 1=1";
       storage.repositories.sourceRecords.put(record);\n`)
    await writeFile(join(root,'packages','test-package','src','old.test.ts'),
      'SELECT * FROM evidence;')
    await writeFile(join(root,'packages','test-package','migrations','old.ts'),
      'SELECT * FROM interactions;')
    await writeFile(join(root,'apps','daemon','src','entry.ts'),
      'await storage.nativeSessionCatalog.claimLegacyWrite(input)')
    await writeFile(join(root,'apps','daemon','src','new.ts'),
      'const reader = source.readNativeSessionPage')
    const hits = await auditLegacyStorageConsumers(root)
    assert.deepEqual(hits.map(item=>item.file), [
      'apps/daemon/src/entry.ts',
      'packages/test-package/src/old.ts',
    ])
    assert.deepEqual(hits[0]?.symbols,['.claimLegacyWrite'])
    assert.deepEqual(hits[1]?.tables,['source_records','observations'])
    assert.deepEqual(hits[1]?.symbols,['.sourceRecords'])
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})
