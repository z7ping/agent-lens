// Development bootstrap shares the exact worker entry used by dist builds.
import { register } from 'tsx/esm/api'
register()
await import('./worker.ts')
