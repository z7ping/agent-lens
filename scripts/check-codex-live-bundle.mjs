import { resolve } from 'node:path'
import { build } from 'esbuild'

// Dry-run the same Codex Integration dependency graph used by the development
// bundle. This catches syntax failures before booting the daemon.
await build({
  entryPoints: [resolve('packages/integration-codex/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  write: false,
  packages: 'bundle',
  mainFields: ['module', 'main'],
  logLevel: 'warning',
})
console.info('[AgentLens] Codex Integration source bundle syntax passed')
