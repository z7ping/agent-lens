import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'

interface SkillMetadata {
  name: string
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

function staticEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    nativeStableId,
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function installedState(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
): NonNullable<DiscoveredAsset['states']> {
  return [{
    state: 'installed',
    value: true,
    observedAt,
    evidenceCandidates: [staticEvidence(path, observedAt, capturedAt, nativeStableId)],
  }]
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

/**
 * Pi uses Agent Skills frontmatter and requires a non-empty description. We only need
 * enough metadata to prove that a Markdown file is a Pi skill and to preserve its name;
 * unsupported YAML constructs are treated conservatively as unproven instead of guessed.
 */
function skillFrontmatter(text: string): { name?: string; description?: string } | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const end = lines.slice(1).findIndex(line => line.trim() === '---')
  if (end < 0) return null
  const body = lines.slice(1, end + 1)
  const result: { name?: string; description?: string } = {}

  for (let index = 0; index < body.length; index += 1) {
    const line = body[index]!
    const match = line.match(/^(name|description):\s*(.*)$/)
    if (!match) continue
    const key = match[1] as 'name' | 'description'
    const raw = match[2] ?? ''
    if (raw === '|' || raw === '>') {
      const chunks: string[] = []
      for (let next = index + 1; next < body.length; next += 1) {
        const continuation = body[next]!
        if (!/^\s+/.test(continuation)) break
        const value = continuation.trim()
        if (value) chunks.push(value)
        index = next
      }
      if (chunks.length) result[key] = chunks.join(raw === '>' ? ' ' : '\n')
      continue
    }
    const value = unquoteYamlScalar(raw)
    if (value) result[key] = value
  }
  return result
}

async function readSkillMetadata(filePath: string): Promise<SkillMetadata | null> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  const frontmatter = skillFrontmatter(text)
  if (!frontmatter?.description?.trim()) return null
  const declared = basename(filePath) === 'SKILL.md'
  const fallback = declared ? basename(dirname(filePath)) : basename(filePath, extname(filePath))
  const name = frontmatter.name?.trim() || fallback
  return name ? { name } : null
}

/** Mirrors Pi's default directory shape: SKILL.md makes a directory a skill root;
 * otherwise direct root Markdown files are candidates and subdirectories are searched. */
async function* walkPiSkillFiles(
  root: string,
  includeRootFiles = true,
): AsyncIterable<string> {
  const entries = await safeEntries(root)
  const declared = entries.find(entry => entry.name === 'SKILL.md')
  if (declared) {
    const path = join(root, declared.name)
    const meta = await safeStat(path)
    if (meta?.isFile()) yield path
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    const meta = await safeStat(path)
    if (!meta) continue
    if (meta.isDirectory()) {
      yield* walkPiSkillFiles(path, false)
      continue
    }
    if (includeRootFiles && meta.isFile() && extname(entry.name).toLowerCase() === '.md') {
      yield path
    }
  }
}

async function* discoverPiSkills(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const root = join(configRoot, 'skills')
  for await (const skillFile of walkPiSkillFiles(root)) {
    const meta = await safeStat(skillFile)
    const skill = await readSkillMetadata(skillFile)
    if (!meta?.isFile() || !skill) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'skill', canonicalName: skill.name, displayName: skill.name },
      binding: { path: dirname(skillFile), source: 'pi:skills' },
      // File presence proves installation only. Whether Pi actually exposes the skill also
      // depends on project trust, configured paths/packages and invocation flags.
      states: installedState(skillFile, observedAt, capturedAt, `skill:${skillFile}`),
    }
  }
}

function extensionName(path: string): string {
  const base = basename(path, extname(path))
  return base === 'index' ? basename(dirname(path)) : base
}

async function piManifestExtensions(directory: string): Promise<string[]> {
  const packageJson = join(directory, 'package.json')
  const meta = await safeStat(packageJson)
  if (!meta?.isFile()) return []
  try {
    const parsed = JSON.parse((await readFile(packageJson, 'utf8')).replace(/^\uFEFF/, '')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const pi = (parsed as Record<string, unknown>).pi
    if (!pi || typeof pi !== 'object' || Array.isArray(pi)) return []
    const extensions = (pi as Record<string, unknown>).extensions
    if (!Array.isArray(extensions) || !extensions.every(item => typeof item === 'string')) return []
    const paths: string[] = []
    for (const item of extensions) {
      const path = resolve(directory, item)
      const entryMeta = await safeStat(path)
      if (entryMeta?.isFile()) paths.push(path)
    }
    return paths
  } catch {
    return []
  }
}

async function extensionEntries(directory: string): Promise<string[]> {
  const fromManifest = await piManifestExtensions(directory)
  if (fromManifest.length) return fromManifest
  for (const name of ['index.ts', 'index.js']) {
    const path = join(directory, name)
    const meta = await safeStat(path)
    if (meta?.isFile()) return [path]
  }
  return []
}

async function* discoverPiExtensions(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const root = join(configRoot, 'extensions')
  const seen = new Set<string>()
  for (const entry of await safeEntries(root)) {
    const path = join(root, entry.name)
    const meta = await safeStat(path)
    if (!meta) continue

    let entries: string[] = []
    if (meta.isFile() && ['.ts', '.js'].includes(extname(entry.name).toLowerCase())) {
      entries = [path]
    } else if (meta.isDirectory()) {
      entries = await extensionEntries(path)
    }

    for (const extensionPath of entries) {
      if (seen.has(extensionPath)) continue
      seen.add(extensionPath)
      const extensionMeta = await safeStat(extensionPath)
      if (!extensionMeta?.isFile()) continue
      const name = extensionName(extensionPath)
      const observedAt = extensionMeta.mtime.toISOString()
      yield {
        definition: { type: 'extension', canonicalName: name, displayName: name },
        binding: { path: extensionPath, source: 'pi:extensions' },
        // Presence under an official Pi resource location proves installation, not runtime
        // activation. `enabled`/`discoverable` deliberately stay unreported here.
        states: installedState(
          extensionPath,
          observedAt,
          capturedAt,
          `extension:${extensionPath}`,
        ),
      }
    }
  }
}

export async function* discoverPiAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const root = ctx.installation.configRoot
  if (!root || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()

  // This installation-scoped pass only reports resources whose presence can be proven from
  // Pi's global resource directories. Project resources, configured external paths and package
  // resources need cwd/trust/package-resolution context that SourceExecutionContext does not
  // currently carry; guessing them here would turn configuration assumptions into fake facts.
  for (const group of [
    discoverPiSkills(root, capturedAt),
    discoverPiExtensions(root, capturedAt),
  ]) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }
}

export const piAssetInternals = {
  walkPiSkillFiles,
  readSkillMetadata,
  extensionEntries,
  piManifestExtensions,
}
