import { build } from 'esbuild'
import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { buildIntegrationPackages } from './build-integration-packages.mjs'

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
await mkdir(resolve(dist, 'integrations', 'hermes'), { recursive: true })

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'])

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  mainFields: ['module', 'main'],
  sourcemap: true,
  legalComments: 'none',
  external: ['@deepseek-ai/cordis', 'better-sqlite3'],
  // YAML 等 CommonJS 依赖仍需加载 Node 内建模块，所有分发入口统一提供 ESM 兼容桥。
  banner: { js: 'import { createRequire as __agentLensCreateRequire } from "node:module"; const require = __agentLensCreateRequire(import.meta.url);' },
}

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/cli/src/index.ts')],
  outfile: resolve(dist, 'cli-core.mjs'),
})

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/cli/src/entry.ts')],
  outfile: resolve(dist, 'cli.mjs'),
  banner: { js: '#!/usr/bin/env node\n' + common.banner.js },
})

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/daemon/src/main.ts')],
  outfile: resolve(dist, 'daemon.mjs'),
})

// One-time read-only v38 migration preparation plus strictly gated Slim
// promotion. This bundle is invoked explicitly by the installed CLI only.
await build({
  ...common,
  entryPoints: [resolve(root, 'scripts/slim-migrate-once.ts')],
  outfile: resolve(dist, 'slim-migrate.mjs'),
})

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/daemon/src/data-runtime/worker.ts')],
  outfile: resolve(dist, 'data-runtime-worker.mjs'),
})

await build({
  ...common,
  entryPoints: [resolve(root, 'apps/daemon/src/native-reader/worker.ts')],
  outfile: resolve(dist, 'native-reader-worker.mjs'),
})

await cp(
  resolve(root, 'packages/runtime-cordis/src/pi-live/worker-entry.mjs'),
  resolve(dist, 'worker-entry.mjs'),
)

await cp(resolve(root, 'packages/web/dist'), resolve(dist, 'web'), { recursive: true })
// #617 M6: v1–v38 schema upgrades are not distributed. The explicit
// offline `slim-migrate.mjs` reads the existing v38 database without applying
// these old migrations; normal Daemon/CLI/Desktop only create/open Slim v1.
await cp(
  resolve(root, 'apps/hook-codex/bin/agent-lens-hook-codex.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-codex.mjs'),
)
await cp(
  resolve(root, 'apps/hook-claude/bin/agent-lens-hook-claude.mjs'),
  resolve(dist, 'hooks/agent-lens-hook-claude.mjs'),
)
await cp(
  resolve(root, 'scripts/windows-hook-dispatcher.ps1'),
  resolve(dist, 'hooks/windows-hook-dispatcher.ps1'),
)
await buildIntegrationPackages({
  root,
  outDir: resolve(dist, 'integration-packages'),
  clean: true,
})

await cp(
  resolve(root, 'apps/hook-hermes/plugin/agent-lens-observer'),
  resolve(dist, 'integrations/hermes/agent-lens-observer'),
  { recursive: true },
)

for (const path of [
  resolve(dist, 'cli.mjs'),
  resolve(dist, 'cli-core.mjs'),
  resolve(dist, 'hooks', 'agent-lens-hook-codex.mjs'),
  resolve(dist, 'hooks', 'agent-lens-hook-claude.mjs'),
]) {
  await chmod(path, 0o755).catch(() => undefined)
}

console.log('[AgentLens] distribution built at dist/')
