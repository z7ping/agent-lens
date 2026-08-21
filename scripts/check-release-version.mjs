import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]
if (!tag) {
  console.error('Release tag is required')
  process.exitCode = 1
} else {
  const normalized = tag.startsWith('v') ? tag.slice(1) : tag
  if (normalized !== packageJson.version) {
    console.error(`Release tag ${tag} does not match package version ${packageJson.version}`)
    process.exitCode = 1
  } else {
    console.log(`Release version verified: ${packageJson.version}`)
  }
}
