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
