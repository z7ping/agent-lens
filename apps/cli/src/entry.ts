import { realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { maybePrintUpdateHint, runUpdateCommand } from './update'

const VERSION = '1.0.0-alpha.2'

function isHelp(args: string[]): boolean {
  const command = args.find(arg => arg !== '--json')
  return !command || command === '--help' || command === '-h' || command === 'help'
}

function isVersion(args: string[]): boolean {
  const command = args.find(arg => arg !== '--json')
  return command === '--version' || command === '-v' || command === 'version'
}

function shouldOfferPassiveUpdate(args: string[], code: number): boolean {
  if (code !== 0 || args.includes('--json') || isHelp(args) || isVersion(args)) return false
  const command = args[0]
  if (command === 'start') return false
  if (command === 'service' && args[1] === 'run') return false
  return true
}

function printUpdateHelp(): void {
  console.log('')
  console.log('更新：')
  console.log('  agent-lens update --check [--json]')
  console.log('  agent-lens update')
}

function runCore(args: string[]): Promise<number> {
  const bundled = import.meta.url.endsWith('.mjs')
  const corePath = fileURLToPath(bundled
    ? new URL('./cli-core.mjs', import.meta.url)
    : new URL('./index.ts', import.meta.url))
  const coreArgs = bundled
    ? [corePath, ...args]
    : ['--import', 'tsx', corePath, ...args]
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, coreArgs, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? 1))
  })
}

function updateArgs(argv: string[]): string[] | null {
  const index = argv.findIndex(arg => arg !== '--json')
  if (index < 0 || argv[index] !== 'update') return null
  return [...argv.slice(0, index), ...argv.slice(index + 1)]
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function isDirectInvocation(
  moduleUrl: string,
  invokedPath: string | undefined,
  canonicalize: (path: string) => string = canonicalPath,
): boolean {
  if (!invokedPath) return false
  return canonicalize(fileURLToPath(moduleUrl)) === canonicalize(resolve(invokedPath))
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const update = updateArgs(argv)
  if (update) return runUpdateCommand(VERSION, update)

  const code = await runCore(argv)
  if (isHelp(argv)) printUpdateHelp()
  else if (shouldOfferPassiveUpdate(argv, code)) await maybePrintUpdateHint(VERSION)
  return code
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export const cliEntryInternals = {
  isHelp,
  isVersion,
  shouldOfferPassiveUpdate,
  updateArgs,
  isDirectInvocation,
}
