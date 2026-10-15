import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWindowsElectronRuntime } from './electron-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [target, arch, ...extra] = process.argv.slice(2)
if (process.platform !== 'win32' || !['nsis', 'dir'].includes(target) || arch !== '--x64' || extra.length) {
  throw new Error('Usage (Windows only): node scripts/build-windows-desktop.mjs <nsis|dir> --x64')
}

const { distPath, version } = resolveWindowsElectronRuntime(root)
const desktopRequire = createRequire(resolve(root, 'apps/desktop/package.json'))
const builderPackagePath = desktopRequire.resolve('electron-builder/package.json')
const builder = JSON.parse(readFileSync(builderPackagePath, 'utf8'))
const builderBin = typeof builder.bin === 'string' ? builder.bin : builder.bin?.['electron-builder']
if (!builderBin) throw new Error('Installed electron-builder has no executable in its package manifest')

const cli = resolve(dirname(builderPackagePath), builderBin)
const result = spawnSync(process.execPath, [
  cli, '--win', target, '--x64', `--config.electronDist=${distPath}`, `--config.electronVersion=${version}`,
], { cwd: resolve(root, 'apps/desktop'), stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exit(result.status ?? 1)
