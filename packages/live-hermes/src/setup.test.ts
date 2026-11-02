import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parseEnv } from 'node:util'
import { initializeLocalHermesApi } from './setup'

async function withHermesHome(run: (home: string) => Promise<void>): Promise<void> {
  const previous = {
    HERMES_HOME: process.env.HERMES_HOME,
    HERMES_PROFILE: process.env.HERMES_PROFILE,
    HERMES_API_URL: process.env.HERMES_API_URL,
    HERMES_API_KEY: process.env.HERMES_API_KEY,
    API_SERVER_KEY: process.env.API_SERVER_KEY,
    API_SERVER_ENABLED: process.env.API_SERVER_ENABLED,
    API_SERVER_HOST: process.env.API_SERVER_HOST,
  }
  const home = await mkdtemp(join(tmpdir(), 'agentlens-hermes-'))
  try {
    for (const key of Object.keys(previous) as Array<keyof typeof previous>) delete process.env[key]
    process.env.HERMES_HOME = home
    await writeFile(join(home, 'config.yaml'), 'gateway:\n  api_server:\n    enabled: false\n')
    await run(home)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
}

test('Hermes bootstrap generates one secret, protects the file and stays idempotent', async () => {
  await withHermesHome(async home => {
    const first = await initializeLocalHermesApi()
    assert.equal(first.changed, true)
    const envPath = join(home, '.env')
    const written = await readFile(envPath, 'utf8')
    const vars = parseEnv(written)
    assert.equal(vars.API_SERVER_ENABLED, 'true')
    assert.match(vars.API_SERVER_KEY ?? '', /^[a-f0-9]{64}$/)
    const secret = vars.API_SERVER_KEY
    assert.equal((await initializeLocalHermesApi()).changed, false)
    assert.equal(parseEnv(await readFile(envPath, 'utf8')).API_SERVER_KEY, secret)
    if (process.platform !== 'win32') {
      assert.equal((await stat(envPath)).mode & 0o077, 0)
    }
  })
})

test('Hermes bootstrap reuses existing key and preserves unrelated settings', async () => {
  await withHermesHome(async home => {
    const secret = randomBytes(32).toString('hex')
    const original = 'SOME_SETTING=hello\nAPI_SERVER_KEY=' + secret + '\nAPI_SERVER_ENABLED=false\n'
    await writeFile(join(home, '.env'), original)
    const result = await initializeLocalHermesApi()
    assert.equal(result.changed, true)
    const value = await readFile(join(home, '.env'), 'utf8')
    assert.equal(parseEnv(value).API_SERVER_KEY, secret)
    assert.equal(parseEnv(value).API_SERVER_ENABLED, 'true')
    assert.match(value, /SOME_SETTING=hello/)
    assert.equal(value.match(/^API_SERVER_KEY=/gm)?.length, 1)
  })
})

test('Hermes bootstrap honors existing YAML key without duplicating the secret in .env', async () => {
  await withHermesHome(async home => {
    await writeFile(join(home, 'config.yaml'), 'gateway:\n  api_server:\n    enabled: false\n    key: existing-yaml-key\n')
    await initializeLocalHermesApi()
    const vars = parseEnv(await readFile(join(home, '.env'), 'utf8'))
    assert.equal(vars.API_SERVER_ENABLED, 'true')
    assert.equal(vars.API_SERVER_KEY, undefined)
  })
})

test('Hermes bootstrap does not modify non-loopback, custom API or unknown profile', async () => {
  await withHermesHome(async home => {
    await writeFile(join(home, '.env'), 'API_SERVER_HOST=0.0.0.0\n')
    await assert.rejects(initializeLocalHermesApi(), /non-loopback/)
    assert.equal(await readFile(join(home, '.env'), 'utf8'), 'API_SERVER_HOST=0.0.0.0\n')
    process.env.HERMES_API_URL = 'http://remote:8642'
    await assert.rejects(initializeLocalHermesApi(), /custom API/)
  })
})

test('Hermes bootstrap refuses symlinked config', async () => {
  await withHermesHome(async home => {
    // Replacing a symlink would silently change another installation's config.
    const fs = await import('node:fs/promises')
    const target = join(home, 'target.env')
    await writeFile(target, 'KEEP=true\n')
    try { await fs.symlink(target, join(home, '.env')) } catch { return } // Windows privilege
    await assert.rejects(initializeLocalHermesApi(), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'KEEP=true\n')
  })
})

test('YAML enabled cannot override an explicit disabled .env value', async () => {
  await withHermesHome(async home => {
    await writeFile(join(home, '.env'), 'API_SERVER_ENABLED=false\nAPI_SERVER_KEY=existing\n')
    await writeFile(join(home, 'config.yaml'), 'gateway:\n  api_server:\n    enabled: true\n')
    await initializeLocalHermesApi()
    assert.equal(parseEnv(await readFile(join(home, '.env'), 'utf8')).API_SERVER_ENABLED, 'true')
  })
})
