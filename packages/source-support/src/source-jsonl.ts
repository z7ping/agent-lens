import { createReadStream } from 'node:fs'

export interface JsonlLine {
  text: string
  startOffset: number
  endOffset: number
  terminated: boolean
}

/**
 * Reads JSONL by byte offset without pretending an unterminated EOF fragment is a complete line.
 *
 * The caller owns record semantics and checkpoint policy:
 * - terminated=true means the source actually emitted a line boundary;
 * - terminated=false means this is the current EOF tail and may still be in-flight.
 */
export async function* readJsonlLines(
  filePath: string,
  startOffset = 0,
): AsyncIterable<JsonlLine> {
  const stream = createReadStream(filePath, { start: startOffset })
  let carry = Buffer.alloc(0)
  let carryOffset = startOffset

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const dataOffset = carryOffset
    let cursor = 0

    while (true) {
      const newline = data.indexOf(0x0a, cursor)
      if (newline < 0) break

      let line = data.subarray(cursor, newline)
      if (line.length && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, -1)
      }

      yield {
        text: line.toString('utf8'),
        startOffset: dataOffset + cursor,
        endOffset: dataOffset + newline + 1,
        terminated: true,
      }
      cursor = newline + 1
    }

    carry = data.subarray(cursor)
    carryOffset = dataOffset + cursor
  }

  if (carry.length) {
    yield {
      text: carry.toString('utf8'),
      startOffset: carryOffset,
      endOffset: carryOffset + carry.length,
      terminated: false,
    }
  }
}

/**
 * Syntactic completeness only. A JSON primitive may be complete but still be semantically invalid
 * for a Source that expects objects; that distinction belongs to the Agent Adapter.
 */
export function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''))
    return true
  } catch {
    return false
  }
}
