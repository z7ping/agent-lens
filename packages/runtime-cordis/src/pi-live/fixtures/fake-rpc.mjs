let carry = Buffer.alloc(0)
process.stdin.on('data', raw => {
  const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
  let cursor = 0
  while (true) {
    const newline = data.indexOf(0x0a, cursor)
    if (newline < 0) break
    let line = data.subarray(cursor, newline)
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
    cursor = newline + 1
    if (!line.length) continue
    const value = JSON.parse(line.toString('utf8'))
    if (value.type === 'extension_ui_response') {
      process.stdout.write(JSON.stringify({ type: 'fixture_extension_seen', id: value.id, confirmed: value.confirmed }) + '\n')
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: value.id, command: value.type, success: true, data: value.type === 'get_state' ? { sessionId: 'fake-session', isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : {} }) + '\n')
    if (value.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '包含 Unicode 分隔符：\u2028\u2029' } }) + '\n')
      process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n')
    }
  }
  carry = data.subarray(cursor)
})
