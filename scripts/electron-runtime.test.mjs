import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { resolveWindowsElectronRuntime } from './electron-runtime.mjs'

function withFixture({ requested = '^43.7.9', locked = '^43.7.9', resolved = '43.7.9', installed = '43.7.9' }, verify) {
  const root = mkdtempSync(join(tmpdir(), 'agentlens-electron-'))
  const write = (path, value) => {
    const fullPath = join(root, path)
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, JSON.stringify(value))
  }
  try {
    write('apps/desktop/package.json', { devDependencies: { electron: requested } })
    write('package-lock.json', {
      packages: {
        'apps/desktop': { devDependencies: { electron: locked } },
        'node_modules/electron': { version: resolved },
      },
    })
    write('node_modules/electron/package.json', { name: 'electron', version: installed })
    verify(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Electron runtime uses the resolved lockfile version, not the semver range', () => {
  withFixture({}, root => {
    const result = resolveWindowsElectronRuntime(root)
    assert.equal(result.version, '43.7.9')
    assert.equal(result.distPath, join(root, 'apps/desktop/.electron-dist/electron-v43.7.9-win32-x64'))
    assert.ok(!result.distPath.includes('^'))
  })
})

test('stale lockfile declaration is rejected rather than silently downloading another version', () => {
  withFixture({ locked: '^43.4.0' }, root => {
    assert.throws(() => resolveWindowsElectronRuntime(root), /package-lock\.json disagree/)
  })
})

test('installed Electron and lockfile mismatch is rejected before download or packaging', () => {
  withFixture({ installed: '43.4.0' }, root => {
    assert.throws(() => resolveWindowsElectronRuntime(root), /differs from lockfile/)
  })
})

test('non-concrete lockfile versions cannot become Electron download URLs', () => {
  withFixture({ resolved: '^43.7.9' }, root => {
    assert.throws(() => resolveWindowsElectronRuntime(root), /no concrete root Electron version/)
  })
})

test('prepare, package and Windows smoke all use one version resolver', () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const prepare = read('scripts/prepare-desktop.mjs')
  const build = read('scripts/build-windows-desktop.mjs')
  const pkg = JSON.parse(read('apps/desktop/package.json'))
  const smoke = read('.github/workflows/alpha3-task-center-real-smoke.yml')
  assert.match(prepare, /resolveWindowsElectronRuntime\(root\)/)
  assert.match(build, /resolveWindowsElectronRuntime\(root\)/)
  assert.match(build, /--config\.electronVersion=\$\{version\}/)
  assert.match(build, /--config\.electronDist=\$\{distPath\}/)
  assert.match(smoke, /node scripts\/electron-runtime\.mjs/)
  assert.match(pkg.scripts['dist:win'], /build-windows-desktop\.mjs nsis --x64/)
  assert.match(pkg.scripts['dist:win:dir'], /build-windows-desktop\.mjs dir --x64/)
  for (const source of [prepare, build, smoke, pkg.scripts['dist:win'], pkg.scripts['dist:win:dir']]) {
    assert.doesNotMatch(source, /electron-v43\.4\.0-win32-x64|devDependencies\.electron}-win32-x64/)
  }
})
