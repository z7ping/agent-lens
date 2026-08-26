import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function quoteDesktopExec(value) {
  return `"${String(value).replace(/[\\"`$]/g, match => `\\${match}`)}"`
}

function linuxAutostartPath(home, env) {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return join(configRoot, 'autostart', 'agentlens.desktop')
}

function linuxDesktopEntry(executable) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=AgentLens',
    'Comment=AgentLens local agent observability',
    `Exec=${quoteDesktopExec(executable)} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}

export function createLoginAutostartController({
  app,
  platform = process.platform,
  execPath = process.execPath,
  home = homedir(),
  env = process.env,
} = {}) {
  const executable = platform === 'linux' && env.APPIMAGE?.trim()
    ? env.APPIMAGE.trim()
    : execPath
  const linuxPath = linuxAutostartPath(home, env)

  function isSupported() {
    return Boolean(app?.isPackaged) && ['win32', 'darwin', 'linux'].includes(platform)
  }

  function platformLabel() {
    if (platform === 'win32') return 'Windows'
    if (platform === 'darwin') return 'macOS'
    if (platform === 'linux') return 'Linux'
    return platform
  }

  function isEnabled() {
    if (!isSupported()) return false
    try {
      if (platform === 'linux') {
        if (!existsSync(linuxPath)) return false
        const source = readFileSync(linuxPath, 'utf8')
        return source.includes('X-GNOME-Autostart-enabled=true') && source.includes('Name=AgentLens')
      }
      if (platform === 'win32') {
        return Boolean(app.getLoginItemSettings({ path: executable, args: ['--hidden'] }).openAtLogin)
      }
      return Boolean(app.getLoginItemSettings().openAtLogin)
    } catch {
      return false
    }
  }

  function setEnabled(enabled) {
    if (!isSupported()) return false
    try {
      if (platform === 'linux') {
        if (enabled) {
          mkdirSync(dirname(linuxPath), { recursive: true })
          writeFileSync(linuxPath, linuxDesktopEntry(executable), 'utf8')
        } else {
          rmSync(linuxPath, { force: true })
        }
        return isEnabled() === enabled
      }

      if (platform === 'win32') {
        app.setLoginItemSettings({ path: executable, args: ['--hidden'], openAtLogin: enabled })
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled })
      }
      return isEnabled() === enabled
    } catch {
      return false
    }
  }

  function shouldStartHidden(argv = process.argv) {
    if (argv.includes('--hidden')) return true
    if (platform !== 'darwin' || !isSupported()) return false
    try {
      return Boolean(app.getLoginItemSettings().wasOpenedAtLogin)
    } catch {
      return false
    }
  }

  function refreshRegistrationIfEnabled() {
    if (!isSupported() || !isEnabled()) return false
    return setEnabled(true)
  }

  return {
    executable,
    linuxPath,
    isSupported,
    platformLabel,
    isEnabled,
    setEnabled,
    shouldStartHidden,
    refreshRegistrationIfEnabled,
  }
}

export const loginAutostartInternals = {
  linuxAutostartPath,
  linuxDesktopEntry,
  quoteDesktopExec,
}
