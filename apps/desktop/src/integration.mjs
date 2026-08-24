import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'

function runCli(args, env) {
  return new Promise(resolve => {
    const cliEntry = join(app.getAppPath(), 'runtime', 'cli.mjs')
    const child = spawn(process.execPath, [cliEntry, ...args], {
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

async function refreshDesktopIntegration() {
  if (process.platform !== 'win32' || !app.isPackaged) return

  const hookRoot = join(process.resourcesPath, 'app.asar.unpacked', 'runtime', 'hooks')
  if (!existsSync(hookRoot)) return

  const env = {
    AGENT_LENS_DISTRIBUTION: 'desktop',
    AGENT_LENS_INSTALLATION_EXECUTABLE: process.execPath,
    AGENT_LENS_HOOK_ROOT: hookRoot,
    AGENT_LENS_VERSION: app.getVersion(),
  }

  const home = homedir()
  const targets = []
  if (existsSync(join(home, '.codex'))) targets.push('codex')
  if (existsSync(join(home, '.claude'))) targets.push('claude')

  if (!targets.length) {
    // Even without a detected Agent, status resolves the profile and registers
    // Desktop as a valid Hook provider for a later installation.
    await runCli(['hook', 'status', 'all', '--json'], env)
    return
  }

  for (const target of targets) {
    await runCli(['hook', 'install', target, '--json'], env)
  }
}

app.whenReady().then(() => refreshDesktopIntegration()).catch(() => undefined)
