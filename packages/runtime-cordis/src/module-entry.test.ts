import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDirectInvocation } from './module-entry'

test('入口识别比较真实文件身份，支持符号链接目录且不会把导入当作启动',async()=>{
  const root=await mkdtemp(join(tmpdir(),'al-entry-'))
  try{
    const real=join(root,'real'),alias=join(root,'alias')
    await mkdir(real)
    const entry=join(real,'daemon.mjs');await writeFile(entry,'')
    await symlink(real,alias,process.platform==='win32'?'junction':'dir')
    const url=pathToFileURL(entry).href
    assert.equal(isDirectInvocation(url,join(alias,'daemon.mjs')),true)
    assert.equal(isDirectInvocation(url,join(alias,'other.mjs')),false)
    assert.equal(isDirectInvocation(url,undefined),false)
  }finally{await rm(root,{recursive:true,force:true})}
})
