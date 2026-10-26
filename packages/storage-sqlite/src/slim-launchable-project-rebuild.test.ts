import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { SqliteSlimStorage } from './slim-storage'

test('Task Center rebuild derives projects/workspaces from native context rather than old SQL sessions',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'local'})
    const install=await slim.identity.resolveInstallation({
      hostId:host.id,productId:'pi',dataRoot:resolve('source'),
    })
    const workspace=await slim.identity.resolveWorkspace({
      hostId:host.id,path:resolve('work'),repositoryRoot:resolve('work'),
      gitRemote:'https://example.invalid/repository',
    })
    assert.ok(workspace?.projectId)
    const time='2026-10-26T09:00:00.000Z'
    await slim.nativeSessionCatalog.upsert({
      sourceId:'pi',installationId:install.id,nativeSessionId:'one',
      locationKind:'native',filePath:resolve('source','one.jsonl'),
      fileIdentity:'1:2',fileSize:200,fileMtimeMs:10,
      lastActivityAt:time,updatedAt:time,
    })
    await slim.nativeSessionContexts.upsert({
      sourceId:'pi',installationId:install.id,nativeSessionId:'one',
      projectId:workspace.projectId,workspaceId:workspace.id,updatedAt:time,
    })
    // Rebuilding a slim database cannot query deleted logical_sessions or
    // session_summary_projection, so this is an actual no-Legacy check.
    await slim.launchableProjects.rebuild()
    let list=await slim.launchableProjects.query({limit:20})
    assert.equal(list.items.length,1)
    assert.equal(list.items[0]?.projectId,workspace.projectId)
    assert.equal(list.items[0]?.lastSeenAt,time)
    assert.equal(list.items[0]?.workspaces[0]?.workspaceId,workspace.id)
    await slim.launchableProjects.recordWorkspaceValidation({
      workspaceId:workspace.id,workspacePath:workspace.path,
      status:'valid',validatedAt:time,
    })
    await slim.launchableProjects.rebuild()
    list=await slim.launchableProjects.query({limit:20})
    assert.equal(list.items[0]?.workspaces[0]?.validationStatus,'valid')
    assert.deepEqual(slim.db.pragma('foreign_key_check'),[])
  }finally{await slim.close()}
})
