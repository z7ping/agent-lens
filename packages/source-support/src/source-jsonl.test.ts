import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isCompleteJson, readJsonlLines, type JsonlLine } from './source-jsonl'

async function collect(path: string, startOffset = 0) {
  const lines: JsonlLine[] = []
  for await (const line of readJsonlLines(path, startOffset)) lines.push(line)
  return lines
}

test('shared JSONL reader exposes terminated lines separately from an in-flight EOF tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-source-jsonl-'))
  const path = join(root, 'session.jsonl')
  const first = '{"type":"session","id":"one"}'
  const partial = '{"type":"message","id":"two","text":"hel'
  await writeFile(path, `${first}\n${partial}`, 'utf8')

  try {
    const lines = await collect(path)
    assert.equal(lines.length, 2)
    assert.deepEqual(lines[0], {
      text: first,
      startOffset: 0,
      endOffset: Buffer.byteLength(first) + 1,
      terminated: true,
    })
    assert.equal(lines[1]?.text, partial)
    assert.equal(lines[1]?.terminated, false)
    assert.equal(isCompleteJson(lines[1]!.text), false)

    // A caller that checkpoints only the terminated first line can reconstruct the original
    // second record after the producer finishes writing it.
    await appendFile(path, 'lo"}\n', 'utf8')
    const resumed = await collect(path, lines[0]!.endOffset)
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0]?.text, '{"type":"message","id":"two","text":"hello"}')
    assert.equal(resumed[0]?.terminated, true)
    assert.equal(isCompleteJson(resumed[0]!.text), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared JSONL reader preserves CRLF boundaries and distinguishes complete unterminated JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-source-jsonl-crlf-'))
  const path = join(root, 'session.jsonl')
  await writeFile(path, '{"ok":1}\r\n{"ok":2}', 'utf8')

  try {
    const lines = await collect(path)
    assert.equal(lines.length, 2)
    assert.equal(lines[0]?.text, '{"ok":1}')
    assert.equal(lines[0]?.terminated, true)
    assert.equal(lines[1]?.text, '{"ok":2}')
    assert.equal(lines[1]?.terminated, false)
    assert.equal(isCompleteJson(lines[1]!.text), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
