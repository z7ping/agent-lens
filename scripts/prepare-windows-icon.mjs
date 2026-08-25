import { readFile, writeFile } from 'node:fs/promises'
import { deflateSync, inflateSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(root, 'apps', 'desktop', 'assets', 'icon.png')
const outputPath = resolve(root, 'apps', 'desktop', 'assets', 'icon-win.png')
const background = [0x0b, 0x0d, 0x10]
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[n] = value >>> 0
  }
  return table
})()

const source = await readFile(sourcePath)
const decoded = decodePng(source)
if (decoded.width !== decoded.height || decoded.width < 256) {
  throw new Error(`Windows 应用图标至少需要 256x256 的正方形源图，当前为 ${decoded.width}x${decoded.height}`)
}

const flattened = Buffer.alloc(decoded.width * decoded.height * 3)
for (let index = 0; index < decoded.width * decoded.height; index += 1) {
  const sourceOffset = index * 4
  const targetOffset = index * 3
  const alpha = decoded.rgba[sourceOffset + 3] / 255
  flattened[targetOffset] = composite(decoded.rgba[sourceOffset], background[0], alpha)
  flattened[targetOffset + 1] = composite(decoded.rgba[sourceOffset + 1], background[1], alpha)
  flattened[targetOffset + 2] = composite(decoded.rgba[sourceOffset + 2], background[2], alpha)
}

await writeFile(outputPath, encodeRgbPng(decoded.width, decoded.height, flattened))
console.log(`[AgentLens] Windows 图标已生成：${outputPath}（${decoded.width}x${decoded.height}，无透明通道）`)

function composite(foreground, backgroundChannel, alpha) {
  return Math.round((foreground * alpha) + (backgroundChannel * (1 - alpha)))
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('icon.png 不是有效 PNG')

  let offset = 8
  let ihdr = null
  let palette = null
  let transparency = null
  const idat = []

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') ihdr = Buffer.from(data)
    else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') transparency = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
  }

  if (!ihdr || ihdr.length !== 13 || !idat.length) throw new Error('icon.png 缺少必要 PNG 数据块')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`暂不支持 icon.png 的 PNG 编码：bitDepth=${bitDepth}, interlace=${interlace}`)
  }

  const channels = colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0
  if (!channels) throw new Error(`暂不支持 icon.png 的 PNG colorType=${colorType}`)
  if (colorType === 3 && (!palette || palette.length < 3)) throw new Error('索引色 icon.png 缺少调色板')

  const scanlineBytes = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const expected = height * (scanlineBytes + 1)
  if (raw.length !== expected) throw new Error(`icon.png 解压尺寸异常：${raw.length} != ${expected}`)

  const pixels = Buffer.alloc(width * height * channels)
  let rawOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset]
    rawOffset += 1
    const rowOffset = y * scanlineBytes
    const previousOffset = (y - 1) * scanlineBytes
    for (let x = 0; x < scanlineBytes; x += 1) {
      const value = raw[rawOffset + x]
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0
      const up = y > 0 ? pixels[previousOffset + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[previousOffset + x - channels] : 0
      pixels[rowOffset + x] = unfilter(value, filter, left, up, upLeft)
    }
    rawOffset += scanlineBytes
  }

  const rgba = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const target = index * 4
    if (colorType === 3) {
      const paletteIndex = pixels[index]
      const paletteOffset = paletteIndex * 3
      if (paletteOffset + 2 >= palette.length) throw new Error(`icon.png 调色板索引越界：${paletteIndex}`)
      rgba[target] = palette[paletteOffset]
      rgba[target + 1] = palette[paletteOffset + 1]
      rgba[target + 2] = palette[paletteOffset + 2]
      rgba[target + 3] = transparency && paletteIndex < transparency.length ? transparency[paletteIndex] : 255
    } else if (colorType === 2) {
      const sourceOffset = index * 3
      rgba[target] = pixels[sourceOffset]
      rgba[target + 1] = pixels[sourceOffset + 1]
      rgba[target + 2] = pixels[sourceOffset + 2]
      rgba[target + 3] = 255
    } else {
      const sourceOffset = index * 4
      rgba[target] = pixels[sourceOffset]
      rgba[target + 1] = pixels[sourceOffset + 1]
      rgba[target + 2] = pixels[sourceOffset + 2]
      rgba[target + 3] = pixels[sourceOffset + 3]
    }
  }

  return { width, height, rgba }
}

function unfilter(value, filter, left, up, upLeft) {
  if (filter === 0) return value
  if (filter === 1) return (value + left) & 0xff
  if (filter === 2) return (value + up) & 0xff
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 0xff
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 0xff
  throw new Error(`icon.png 使用了未知 PNG filter=${filter}`)
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft
  const leftDistance = Math.abs(prediction - left)
  const upDistance = Math.abs(prediction - up)
  const upLeftDistance = Math.abs(prediction - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  if (upDistance <= upLeftDistance) return up
  return upLeft
}

function encodeRgbPng(width, height, rgb) {
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1)
    raw[rowOffset] = 0
    rgb.copy(raw, rowOffset + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return chunk
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
