import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('HTTP surface can mount and dispose a SPA dynamically for the Web plugin', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const webRoot = await mkdtemp(join(tmpdir(), 'agent-lens-mounted-web-'))
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Mounted AgentLens</title>', 'utf8')
  await writeFile(join(webRoot, 'assets', 'app.js'), 'console.log("mounted-web")', 'utf8')

  const surface = await startHttpSurface(storage, { port: 0 })
  try {
    const base = `http://${surface.host}:${surface.port}`
    assert.equal((await fetch(`${base}/`)).status, 404)

    const mount = surface.mountStatic({
      id: '@agent-lens/web:test',
      directory: webRoot,
      spaFallback: true,
    })

    const route = await fetch(`${base}/review/session-1`)
    assert.equal(route.status, 200)
    assert.match(await route.text(), /Mounted AgentLens/)

    const asset = await fetch(`${base}/assets/app.js`)
    assert.equal(asset.status, 200)
    assert.match(await asset.text(), /mounted-web/)

    await mount.dispose()
    assert.equal((await fetch(`${base}/`)).status, 404)
  } finally {
    await surface.dispose()
    storage.close()
    await rm(webRoot, { recursive: true, force: true })
  }
})
