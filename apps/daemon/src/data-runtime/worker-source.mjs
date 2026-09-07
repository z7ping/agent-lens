// Source-mode Data Runtime bootstrap.
// Register tsx programmatically before importing the TypeScript worker so
// source development, benchmarks and tests use the same .mjs entry shape as dist.
import { register } from 'tsx/esm/api'

register()
await import('./worker.ts')
