import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args){
  return spawnSync(process.execPath,['--import','tsx',
    'scripts/slim-discover-assets.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}
test('slim asset CLI requires explicit Source/installation and staging',()=>{
  const result=run()
  assert.equal(result.status,1)
  assert.match(result.stderr,/requires --staging, --source and --installation/)
})
test('slim asset CLI never implicitly creates a staging DB',()=>{
  const result=run('--staging','nonexistent-asset-stage.sqlite',
    '--source','pi','--installation','i')
  assert.equal(result.status,1)
  assert.match(result.stderr,/Slim asset discovery refused/)
  assert.equal(result.stdout,'')
})
