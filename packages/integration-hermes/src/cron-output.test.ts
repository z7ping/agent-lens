import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHermesCronOutput } from './cron-output.js'

test('Cron outputs are listed by profile and previewed as bounded read-only original files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-hermes-cron-output-'))
  try{
    const own=join(root,'profiles','coder','cron','output','job1')
    const other=join(root,'cron','output','job1')
    await Promise.all([mkdir(own,{recursive:true}),mkdir(other,{recursive:true})])
    await writeFile(join(own,'2026-11-03_08-00-00.md'),'# Coder result\n')
    await writeFile(join(other,'2026-11-03_08-00-00.md'),'# Default result\n')
    await writeFile(join(own,'secret.env'),'CREDENTIAL=do-not-show')
    const result=await readHermesCronOutput({roots:[root],profile:'coder',jobId:'job1'})
    assert.equal(result.state,'available')
    assert.deepEqual(result.files.map(file=>file.name),['2026-11-03_08-00-00.md'])
    const preview=await readHermesCronOutput({roots:[root],profile:'coder',jobId:'job1',file:'2026-11-03_08-00-00.md'})
    assert.equal(preview.preview?.text,'# Coder result\n')
    const missing=await readHermesCronOutput({roots:[root],profile:'coder',jobId:'job1',file:'2026-11-03_08-00-01.md'})
    assert.equal(missing.state,'unavailable')
    assert.equal(missing.preview,undefined)
    const defaultProfile=await readHermesCronOutput({roots:[root],profile:'default',jobId:'job1',file:'2026-11-03_08-00-00.md'})
    assert.equal(defaultProfile.preview?.text,'# Default result\n')
  }finally{await rm(root,{recursive:true,force:true})}
})
test('Cron output file listings are paged, not silently sampled',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-hermes-output-pages-'))
  try{
    const folder=join(root,'cron','output','job1')
    await mkdir(folder,{recursive:true})
    for(let index=0;index<55;index++) {
      await writeFile(join(folder,'2026-11-03_08-'+String(index).padStart(2,'0')+'-00.md'),'ok')
    }
    const first=await readHermesCronOutput({roots:[root],profile:'default',jobId:'job1'})
    assert.equal(first.files.length,50)
    assert.equal(first.hasMore,true)
    const second=await readHermesCronOutput({roots:[root],profile:'default',jobId:'job1',offset:50})
    assert.equal(second.files.length,5)
    assert.equal(second.hasMore,false)
  }finally{await rm(root,{recursive:true,force:true})}
})
test('Cron preview rejects traversal and oversize content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentlens-hermes-output-security-'))
  try{
    const folder=join(root,'cron','output','job1')
    await mkdir(folder,{recursive:true})
    await writeFile(join(folder,'2026-11-03_08-00-00.md'),'x'.repeat(260*1024))
    await assert.rejects(readHermesCronOutput({roots:[root],profile:'default',jobId:'job1',file:'../secret.env'}))
    await assert.rejects(readHermesCronOutput({roots:[root],profile:'default',jobId:'job1',file:'2026-11-03_08-00-00.md'}),/budget/)
  }finally{await rm(root,{recursive:true,force:true})}
})
