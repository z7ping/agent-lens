import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = resolve(repositoryRoot, 'apps/desktop/assets/icon-256.png.b64')
const targetPath = resolve(repositoryRoot, 'apps/desktop/assets/icon.png')

const encoded = (await readFile(sourcePath, 'utf8')).replace(/\s+/g, '')
const png = Buffer.from(encoded, 'base64')
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

if (png.length < signature.length || !png.subarray(0, signature.length).equals(signature)) {
  throw new Error('AgentLens 桌面图标源不是有效的 PNG 数据')
}

await writeFile(targetPath, png)
console.log(`[AgentLens] 已生成桌面图标：${targetPath}`)
