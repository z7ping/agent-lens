import { build } from 'esbuild'
import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`)))
  })
}

await rm(dist, { recursive: true, force: true })
await mkdir(resolve(dist, 'hooks'), { recursive: true })

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'])

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  sourcemap: true,
  legalComments: 'none',
  external: ['@deepseek-ai/cordis', 'better-sqlite3'],
}

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/cli/src/index.ts')],
  outfile: resolve(dist, 'cli.mjs'),
  banner: { js: '#!/usr/bin/env node' },
})

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/daemon/src/main.ts')],
  outfile: resolve(dist, 'daemon.mjs'),
})

await cp(resolve(root, 'packages/web/dist'), resolve(dist, 'web'), { recursive: true })
await cp(
  resolve(root, 'packages/storage-sqlite/migrations'),
  resolve(dist, 'migrations'),
  { recursive: true },
)
await cp(
  resolve(root, 'apps/hook-codex/bin/agent-lens-hook-codex.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-codex.mjs'),
)
await cp(
  resolve(root, 'apps/hook-claude/bin/agent-lens-hook-claude.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-claude.mjs'),
)
await cp(
  resolve(root, 'scripts/windows-hook-runner.ps1'),
  resolve(dist, 'hooks/agent-lens-hook-runner.ps1'),
)

for (const path of [
  resolve(dist, 'cli.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-codex.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-claude.mjs'),
]) {
  await chmod(path, 0o755).catch(() => undefined)
}

console.log('[AgentLens] distribution built at dist/')
