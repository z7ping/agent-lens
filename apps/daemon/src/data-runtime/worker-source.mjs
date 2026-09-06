// Source-mode Data Runtime bootstrap.
// Register tsx explicitly before importing the TypeScript worker so source
// development, benchmarks and tests use the same .mjs entry shape as dist.
import 'tsx'
await import('./worker.ts')
