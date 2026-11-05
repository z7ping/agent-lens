import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceFilePreviewPath } from './workspace-file-preview-path'

test('only source-attested paths inside an absolute workspace may be previewed', () => {
  assert.equal(workspaceFilePreviewPath('/repo', 'src/main.ts'), '/repo/src/main.ts')
  assert.equal(workspaceFilePreviewPath('/repo', './docs/README.md'), '/repo/docs/README.md')
  assert.equal(workspaceFilePreviewPath('/repo', '/repo/src/main.ts'), '/repo/src/main.ts')
  assert.equal(workspaceFilePreviewPath('C:\\project', 'src\\main.ts'), 'C:/project/src/main.ts')
  assert.equal(workspaceFilePreviewPath('C:\\project', 'c:\\PROJECT\\src\\main.ts'), 'C:/project/src/main.ts')
})
test('reject directory traversal, drive-relative, foreign roots, and missing evidence', () => {
  for (const bad of ['../secrets', 'src/../secret', '/etc/passwd', '/repository/file', 'C:relative.ts', '', 'src//x', 'src/./file']) {
    assert.equal(workspaceFilePreviewPath('/repo', bad), undefined, bad)
  }
  assert.equal(workspaceFilePreviewPath(undefined, 'file.ts'), undefined)
  assert.equal(workspaceFilePreviewPath('repo', 'file.ts'), undefined)
  assert.equal(workspaceFilePreviewPath('C:\\project', 'D:\\secret.txt'), undefined)
  assert.equal(workspaceFilePreviewPath('/repo', 'src/\0secret'), undefined)
})
