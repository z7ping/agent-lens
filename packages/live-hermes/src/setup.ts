import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { parse as parseYaml } from 'yaml'

/** A local, explicitly approved bootstrap. Never provisions remote or unknown Hermes profiles. */
export interface HermesLocalApiSetup {
  changed: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function configValue(value: unknown): string | undefined {
  return (typeof value === 'string' && value.trim())
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error('Hermes configuration must be a regular file (no symlinks)')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function locateHermesHome(): Promise<string> {
  if (process.env.HERMES_PROFILE && !process.env.HERMES_HOME) {
    throw new Error('Named Hermes profile detected; select its HERMES_HOME explicitly before initialization')
  }
  const roots = process.env.HERMES_HOME
    ? [process.env.HERMES_HOME]
    : [
        join(homedir(), '.hermes'),
        ...(process.platform === 'win32' && process.env.LOCALAPPDATA
          ? [join(process.env.LOCALAPPDATA, 'hermes')] : []),
      ]
  for (const root of roots) {
    try {
      const directory = await stat(root)
      if (!directory.isDirectory()) continue
      if (await regularFile(join(root, '.env')) || await regularFile(join(root, 'config.yaml'))) {
        return root
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error('Hermes configuration directory was not found; install/setup Hermes first')
}

function configureEnv(original: string, key: string, enabled: boolean): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original ? original.split(/\r?\n/) : []
  const set = (name: string, value: string) => {
    const matcher = new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*=')
    const indices = lines.flatMap((line, index) => matcher.test(line) ? [index] : [])
    if (indices.length > 1) throw new Error('Hermes .env has duplicate ' + name + ' entries')
    if (indices.length) lines[indices[0]!] = name + '=' + value
    else lines.push(name + '=' + value)
  }
  if (enabled) set('API_SERVER_ENABLED', 'true')
  if (key) set('API_SERVER_KEY', key)
  // Remove the empty trailing line introduced by split(), then terminate once.
  while (lines.at(-1) === '') lines.pop()
  return lines.join(eol) + eol
}

let setupInFlight: Promise<HermesLocalApiSetup> | undefined

export function initializeLocalHermesApi(): Promise<HermesLocalApiSetup> {
  if (setupInFlight) return setupInFlight
  setupInFlight = initializeLocalHermesApiOnce().finally(() => { setupInFlight = undefined })
  return setupInFlight
}

async function initializeLocalHermesApiOnce(): Promise<HermesLocalApiSetup> {
  if (process.env.HERMES_API_URL || process.env.HERMES_API_KEY) {
    throw new Error('Hermes uses a custom API endpoint or key; configure that connection manually')
  }
  const root = await locateHermesHome()
  const envPath = join(root, '.env')
  const yamlPath = join(root, 'config.yaml')
  const existing = await regularFile(envPath)
  const original = existing ? await readFile(envPath, 'utf8') : ''
  if (Buffer.byteLength(original) > 256 * 1024) throw new Error('Hermes .env is too large to safely modify')
  let values: Record<string, string>
  try { values = parseEnv(original) } catch { throw new Error('Hermes .env cannot be parsed; no changes made') }

  let yamlApi: Record<string, unknown> = {}
  if (await regularFile(yamlPath)) {
    try {
      const yaml = record(parseYaml(await readFile(yamlPath, 'utf8')))
      const gateway = record(yaml.gateway)
      yamlApi = record(gateway.api_server)
      if (!Object.keys(yamlApi).length) yamlApi = record(record(gateway.platforms).api_server)
      if (!Object.keys(yamlApi).length) yamlApi = record(record(yaml.platforms).api_server)
    } catch { throw new Error('Hermes config.yaml cannot be parsed; no changes made') }
  }

  const host = process.env.API_SERVER_HOST?.trim()
    || values.API_SERVER_HOST?.trim() || configValue(yamlApi.host) || '127.0.0.1'
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase())) {
    throw new Error('Hermes API is configured for a non-loopback host; automatic initialization is disabled')
  }
  if (process.env.API_SERVER_ENABLED && !['true', '1'].includes(process.env.API_SERVER_ENABLED.toLowerCase())) {
    throw new Error('API_SERVER_ENABLED is disabled by the process environment; update that environment first')
  }
  // AgentLens-only process variables do not prove that the Hermes gateway receives them.
  if (process.env.API_SERVER_KEY && !values.API_SERVER_KEY?.trim() && !configValue(yamlApi.key)) {
    throw new Error('API_SERVER_KEY is process-only; configure the Hermes gateway environment manually')
  }
  const key = values.API_SERVER_KEY?.trim()
    || configValue(yamlApi.key)
    || randomBytes(32).toString('hex')
  const enabledInFile = ['true', '1'].includes((values.API_SERVER_ENABLED ?? '').toLowerCase())
  const enabledInYaml = yamlApi.enabled === true
  // A false .env value overrides an enabled YAML setting.
  const needsEnabled = !enabledInFile && (values.API_SERVER_ENABLED !== undefined || !enabledInYaml)
  const needsKey = !values.API_SERVER_KEY?.trim() && !configValue(yamlApi.key)
  if (!needsEnabled && !needsKey) return { changed: false }

  // Respect the existing YAML key. Only write fields that actually need enabling.
  const updated = configureEnv(original, needsKey ? key : '', needsEnabled)
  if (updated === original) return { changed: false }
  // Re-check right before replacing; a concurrent external edit must not be clobbered.
  if ((await regularFile(envPath)) !== existing
    || (existing && await readFile(envPath, 'utf8') !== original)) {
    throw new Error('Hermes .env changed during initialization; retry')
  }
  const temporary = join(root, '.env.agentlens-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 })
    await rename(temporary, envPath)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return { changed: true }
}
