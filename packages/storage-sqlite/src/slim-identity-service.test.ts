import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteSlimStorage } from './slim-storage'

test('new slim install resolves stable native identities without any Legacy session tables',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await storage.identity.resolveHost({
      name:'localhost',platform:'win32',arch:'x64',
    })
    const first=await storage.identity.resolveInstallation({
      hostId:host.id,productId:'pi',executable:'C:/pi/first.exe',
      configRoot:'C:\\Config\\PI',dataRoot:'C:\\Data\\PI',
    })
    const second=await storage.identity.resolveInstallation({
      hostId:host.id,productId:'pi',executable:'C:/pi/second.exe',
      configRoot:'c:/config/pi',dataRoot:'c:/data/pi',
    })
    assert.equal(second.id,first.id)
    assert.equal(second.executable,'C:/pi/second.exe')
    assert.equal(second.firstSeenAt,first.firstSeenAt)
    assert.equal((await storage.repositories.installations.get(first.id))?.id,first.id)
    const project=await storage.identity.resolveProject({
      name:'AgentLens',repositoryIdentity:'https://github.com/z7ping/agent-lens',
    })
    assert.ok(project)
    const workspace=await storage.identity.resolveWorkspace({
      hostId:host.id,path:'C:\\Code\\agent-lens',
      repositoryRoot:'C:\\Code\\agent-lens',
      gitRemote:'https://github.com/z7ping/agent-lens',
    })
    assert.ok(workspace)
    assert.equal(workspace.projectId,project.id)
    const result=await storage.launchableProjects.query({limit:10})
    assert.equal(result.items.length,1)
    assert.equal(result.items[0]?.projectId,project.id)
    assert.equal(result.items[0]?.workspaces[0]?.workspaceId,workspace.id)
    assert.deepEqual(storage.db.prepare(`SELECT name FROM sqlite_master
      WHERE name IN ('logical_sessions','source_sessions','observations')`).all(),[])
  }finally{await storage.close()}
})

test('same host, product, and root preserves identity across repeated detection',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await storage.identity.resolveHost({name:'local'})
    const a=await storage.identity.resolveInstallation({
      hostId:host.id,productId:'codex',dataRoot:'/tmp/codex',
    })
    const b=await storage.identity.resolveInstallation({
      hostId:host.id,productId:'codex',dataRoot:'/tmp/codex',
      version:'0.1.1',
    })
    assert.equal(a.id,b.id)
    assert.equal(b.version,'0.1.1')
    assert.deepEqual(storage.db.pragma('foreign_key_check'),[])
  }finally{await storage.close()}
})

test('native cwd without Git attribution is indexed as a real local project and remains stable', async () => {
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try {
    const host=await storage.identity.resolveHost({name:'local'})
    const install=await storage.identity.resolveInstallation({hostId:host.id,productId:'pi'})
    const cwd='/work/agent-lens'
    const workspace=await storage.identity.resolveWorkspace({hostId:host.id,path:cwd})
    assert.ok(workspace?.projectId)
    const project=storage.db.prepare('SELECT name,repository_identity FROM projects WHERE id=?')
      .get(workspace.projectId) as {name:string;repository_identity:string}
    assert.equal(project.name,'agent-lens')
    assert.equal(project.repository_identity,'local-workspace:'+host.id+':'+cwd)
    const again=await storage.identity.resolveWorkspace({hostId:host.id,path:cwd})
    assert.equal(again?.projectId,workspace.projectId)
    const time='2026-10-29T11:00:00Z'
    await storage.nativeSessionCatalog.upsert({
      sourceId:'pi',installationId:install.id,nativeSessionId:'native-one',
      locationKind:'native',filePath:'/source/one.jsonl',
      fileIdentity:'test:1',fileSize:20,fileMtimeMs:1,
      lastActivityAt:time,updatedAt:time,
    })
    await storage.nativeSessionContexts.upsert({
      sourceId:'pi',installationId:install.id,nativeSessionId:'native-one',
      workspaceId:workspace.id,projectId:workspace.projectId,
    })
    assert.equal((await storage.nativeSessionList.query({limit:10})).items[0]?.projectName,'agent-lens')
    assert.equal((await storage.nativeFacets.query()).projects[0]?.id,workspace.projectId)
    await storage.launchableProjects.rebuild()
    const available=await storage.launchableProjects.query({limit:10})
    assert.equal(available.items[0]?.projectId,workspace.projectId)
    assert.equal(available.items[0]?.workspaces[0]?.workspacePath,cwd)
    assert.deepEqual(storage.db.pragma('foreign_key_check'),[])
  }finally{await storage.close()}
})

test('repeat native cwd attribution does not replace a previously attested Git project',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await storage.identity.resolveHost({name:'local'})
    const cwd='/work/agent-lens'
    const git=await storage.identity.resolveWorkspace({
      hostId:host.id,path:cwd,repositoryRoot:cwd,gitRemote:'https://example.org/org/agent-lens.git',
    })
    assert.ok(git?.projectId)
    const revisited=await storage.identity.resolveWorkspace({hostId:host.id,path:cwd})
    assert.equal(revisited?.projectId,git.projectId)
    const count=storage.db.prepare('SELECT COUNT(*) as count FROM projects')
      .get() as {count:number}
    assert.equal(count.count,1)
  }finally{await storage.close()}
})

test('Git identity supersedes a local cwd project without duplicate project filters',async()=>{
  const storage=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await storage.identity.resolveHost({name:'local'})
    const cwd='/work/git-project'
    const local=await storage.identity.resolveWorkspace({hostId:host.id,path:cwd})
    assert.ok(local?.projectId)
    const git=await storage.identity.resolveWorkspace({
      hostId:host.id,path:cwd,repositoryRoot:cwd,
      gitRemote:'https://example.org/git-project.git',
    })
    assert.ok(git?.projectId)
    assert.notEqual(git.projectId,local.projectId)
    const options=await storage.nativeFacets.query()
    assert.deepEqual(options.projects.map(value=>value.id),[git.projectId])
    const candidate=await storage.launchableProjects.query({limit:10})
    assert.deepEqual(candidate.items.map(value=>value.projectId),[git.projectId])
  }finally{await storage.close()}
})
