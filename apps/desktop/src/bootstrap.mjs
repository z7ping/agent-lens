import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function bootStage(stage) {
  const target = process.env.AGENT_LENS_DESKTOP_BOOT_LOG
  if (!target) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${new Date().toISOString()} bootstrap ${stage} pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`, 'utf8')
  } catch {
    // Diagnostic logging must never change desktop startup semantics.
  }
}

bootStage('entered')
bootStage('before-main-import')
await import('./main.mjs')
bootStage('after-main-import')
await import('./integration.mjs')
bootStage('after-integration-import')
