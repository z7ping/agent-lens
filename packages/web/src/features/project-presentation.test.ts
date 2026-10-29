import assert from 'node:assert/strict'
import test from 'node:test'
import { projectDisplayIdentity, projectSelectOption } from './project-presentation'

test('本地项目选项展示完整路径，保留身份但不展示主机标识', () => {
  assert.deepEqual(projectSelectOption({
    id:'project-id',name:'项目',repositoryIdentity:'local-workspace:host-id:f:/work/项目',
  }), {value:'project-id',label:'项目',description:'f:/work/项目'})
  assert.equal(projectDisplayIdentity('local-workspace:host-id:/work/project'), '/work/project')
  const networkPath = String.raw`\\server\share`
  assert.equal(projectDisplayIdentity('local-workspace:host-id:' + networkPath), networkPath)
})

test('仓库地址保持可读原值，缺少名称的本地项目仍不泄露内部标识', () => {
  assert.equal(projectDisplayIdentity('https://example.com/org/repo.git'), 'https://example.com/org/repo.git')
  assert.equal(projectDisplayIdentity('git@example.com:org/repo.git'), 'git@example.com:org/repo.git')
  assert.deepEqual(projectSelectOption({id:'p',repositoryIdentity:'local-workspace:host-id:/work/p'}), {
    value:'p',label:'/work/p',description:'/work/p',
  })
  assert.deepEqual(projectSelectOption({id:'p'}), {value:'p',label:'p'})
})
