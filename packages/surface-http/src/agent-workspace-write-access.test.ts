import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkspaceWriteAccess } from './agent-workspace-write-access'

test('workspace write permission is deny-by-default, scoped to exact native installation root, and persisted',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agent-lens-work-write-'))
  const path=join(dir,'scope.json')
  const scope={sourceId:'hermes',installationId:'hermes-one',root:join(dir,'hermes-a')}
  try{
    const access=await createWorkspaceWriteAccess(path)
    assert.equal(access.allowed(scope),false)
    await access.set(scope,true)
    assert.equal(access.allowed(scope),true)
    assert.equal(access.allowed({...scope,sourceId:'pi'}),false)
    assert.equal(access.allowed({...scope,installationId:'hermes-two'}),false)
    assert.equal(access.allowed({...scope,root:join(dir,'hermes-b')}),false)
    const restarted=await createWorkspaceWriteAccess(path)
    assert.equal(restarted.allowed(scope),true)
    await restarted.set(scope,false)
    assert.equal(restarted.allowed(scope),false)
    assert.equal((await readFile(path,'utf8')).includes('hermes-one'),false)
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('permission writes are serialized and malformed preferences fail closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agent-lens-work-scope-'))
  const path=join(dir,'scope.json')
  const scope={sourceId:'hermes',installationId:'id-a',root:join(dir,'hermes')}
  try{
    const access=await createWorkspaceWriteAccess(path)
    await Promise.all([access.set(scope,true),access.set(scope,false),access.set(scope,true)])
    assert.equal(access.allowed(scope),true)
    assert.equal((await createWorkspaceWriteAccess(path)).allowed(scope),true)
    assert.equal(access.allowed({...scope,installationId:'id-b'}),false)
    await writeFile(path,'{"version":99,"grants":[]}')
    await assert.rejects(createWorkspaceWriteAccess(path),/cannot be loaded/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
