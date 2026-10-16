import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveElectronVersion } from './electron-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [platform, target, arch, signing, ...extra] = process.argv.slice(2)
const isMac = platform === 'mac'
const isLinux = platform === 'linux'

if (extra.length
  || (isMac && (process.platform !== 'darwin' || !['dmg-zip', 'dir'].includes(target)
    || !['--arm64', '--x64'].includes(arch) || !['unsigned', 'signed'].includes(signing)))
  || (isLinux && (process.platform !== 'linux' || !['packages', 'dir'].includes(target)
    || arch !== '--x64' || signing !== undefined))
  || (!isMac && !isLinux)) {
  throw new Error('Usage: <mac dmg-zip|dir --arm64|--x64 unsigned|signed> | <linux packages|dir --x64>')
}
if (isMac && target === 'dir' && signing === 'signed') {
  throw new Error('Signed macOS directory builds are not release artifacts')
}

const desktopRequire = createRequire(resolve(root, 'apps/desktop/package.json'))
const builderPackagePath = desktopRequire.resolve('electron-builder/package.json')
const builder = JSON.parse(readFileSync(builderPackagePath, 'utf8'))
const builderBin = typeof builder.bin === 'string' ? builder.bin : builder.bin?.['electron-builder']
if (!builderBin) throw new Error('Installed electron-builder has no executable in its package manifest')

const cli = resolve(dirname(builderPackagePath), builderBin)
const targets = target === 'dmg-zip' ? ['dmg', 'zip']
  : target === 'packages' ? ['AppImage', 'deb'] : ['dir']
const args = [
  cli,
  isMac ? '--mac' : '--linux',
  ...targets,
  arch,
  `--config.directories.output=../../release/${isMac ? 'macos' : 'linux'}`,
  `--config.electronVersion=${resolveElectronVersion(root)}`,
  '--publish=never',
]
if (isMac && signing === 'unsigned') {
  args.push('--config.mac.identity=null', '--config.mac.hardenedRuntime=false')
} else if (isMac && signing === 'signed') {
  args.push('--config.mac.forceCodeSigning=true', '--config.mac.notarize=true')
}
const result = spawnSync(process.execPath, args, {
  cwd: resolve(root, 'apps/desktop'), stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
