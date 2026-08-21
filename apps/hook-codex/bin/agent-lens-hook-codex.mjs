#!/usr/bin/env node
import { persistCodexHookEvent, neutralHookOutput } from '../src/inbox.mjs'

async function readStdin(limit = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) throw new Error('Codex hook payload exceeds 2 MiB limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

let eventName = ''
try {
  const raw = await readStdin()
  if (raw.trim()) {
    const event = JSON.parse(raw)
    eventName = typeof event?.hook_event_name === 'string' ? event.hook_event_name : ''
    await persistCodexHookEvent(event)
  }
} catch {
  // Observability must not block or mutate the Codex hook flow.
}

const output = neutralHookOutput(eventName)
if (output) process.stdout.write(output)
