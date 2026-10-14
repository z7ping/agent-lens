import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Resolve the concrete Electron installed by npm ci. Neither package.json's
 * semver range nor a hardcoded release number is a downloadable artifact.
 */
export function resolveWindowsElectronRuntime(root = projectRoot) {
  const desktopPackage = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const requestedRange = desktopPackage.devDependencies?.electron
  const lockedRange = lock.packages?.['apps/desktop']?.devDependencies?.electron
  const version = lock.packages?.['node_modules/electron']?.version

  if (!requestedRange || requestedRange !== lockedRange) {
    throw new Error('Electron dependency and package-lock.json disagree; run npm install to update the lockfile')
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('package-lock.json has no concrete root Electron version; run npm install')
  }

  const desktopRequire = createRequire(resolve(root, 'apps/desktop/package.json'))
  let installedVersion
  try {
    installedVersion = desktopRequire('electron/package.json').version
  } catch (error) {
    throw new Error('Electron is not installed; run npm ci before preparing or packaging desktop', { cause: error })
  }
  if (installedVersion !== version) {
    throw new Error(`Installed Electron ${installedVersion} differs from lockfile ${version}; run npm ci`)
  }

  return {
    version,
    distPath: resolve(root, 'apps/desktop/.electron-dist', `electron-v${version}-win32-x64`),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // PowerShell consumers need a single machine-readable line with no banner.
  process.stdout.write(`${resolveWindowsElectronRuntime().distPath}\n`)
}
