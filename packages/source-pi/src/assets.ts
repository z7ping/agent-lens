import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import type {
  DiscoveredAsset,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import { isMissingPathError, loadInstalledPiSdk } from '@agent-lens/runtime-cordis'
import { resolvePiResourceAssets } from './resource-resolver'

interface SkillMetadata {
  name: string
  filePath: string
}

interface PiSkillLoaderResult {
  skills?: unknown
}

type PiSkillLoader = (options: { dir: string; source: string }) => PiSkillLoaderResult

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
}

function staticEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function installationOnlyStates(
  path: string,
  observedAt: string,
  capturedAt: string,
): NonNullable<DiscoveredAsset['states']> {
  return [
    {
      state: 'installed',
      value: true,
      observedAt,
      evidenceCandidates: [staticEvidence(path, observedAt, capturedAt)],
    },
    {
      // Keep uncertainty explicit so existing optimistic state observations are superseded.
      // Resource presence alone does not prove discoverability for every Pi invocation.
      state: 'discoverable',
      value: 'unknown',
      observedAt: capturedAt,
    },
  ]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function installedSkillLoader(module: unknown): PiSkillLoader | undefined {
  const loader = asRecord(module).loadSkillsFromDir
  return typeof loader === 'function' ? loader as PiSkillLoader : undefined
}

function normalizeLoadedSkills(value: unknown): SkillMetadata[] | null {
  if (!Array.isArray(value)) return null
  const skills: SkillMetadata[] = []
  for (const raw of value) {
    const skill = asRecord(raw)
    if (typeof skill.name !== 'string' || !skill.name.trim()) return null
    if (typeof skill.filePath !== 'string' || !skill.filePath) return null
    skills.push({ name: skill.name, filePath: skill.filePath })
  }
  return skills
}

/**
 * Prefer the resource loader from the actual installed Pi version. This keeps AgentLens aligned
 * with Pi's YAML/frontmatter, ignore-file and recursive discovery semantics without copying them.
 * null means the installed SDK cannot prove the resource set, so the caller may use a conservative
 * filesystem fallback instead.
 */
async function loadSkillsWithInstalledPi(
  ctx: SourceExecutionContext,
  root: string,
): Promise<SkillMetadata[] | null> {
  const executable = ctx.installation.executable
  if (!executable) return null
  try {
    const installed = await loadInstalledPiSdk(executable)
    const loader = installedSkillLoader(installed.module)
    if (!loader) return null
    const result = loader({ dir: root, source: 'user' })
    return normalizeLoadedSkills(result.skills)
  } catch (error) {
    // Missing/permission/IO errors mean the installed Pi view is currently unavailable, not that
    // the richer asset inventory disappeared. Only non-filesystem incompatibility may fall back.
    if (error && typeof error === 'object' && 'code' in error) throw error
    return null
  }
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
 * Conservative fallback used only when the actual installed Pi loader cannot be resolved.
 * Unsupported YAML stays unproven rather than being guessed as a valid Pi skill.
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
        const item = continuation.trim()
        if (item) chunks.push(item)
        index = next
      }
      if (chunks.length) result[key] = chunks.join(raw === '>' ? ' ' : '\n')
      continue
    }
    const item = unquoteYamlScalar(raw)
    if (item) result[key] = item
  }
  return result
}

async function readSkillMetadata(filePath: string): Promise<SkillMetadata | null> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  const frontmatter = skillFrontmatter(text)
  if (!frontmatter?.description?.trim()) return null
  const declared = basename(filePath) === 'SKILL.md'
  const fallback = declared ? basename(dirname(filePath)) : basename(filePath, extname(filePath))
  const name = frontmatter.name?.trim() || fallback
  return name ? { name, filePath } : null
}

/** Pi-compatible directory shape for the conservative no-SDK fallback. */
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

async function fallbackSkills(root: string): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []
  for await (const skillFile of walkPiSkillFiles(root)) {
    const skill = await readSkillMetadata(skillFile)
    if (skill) skills.push(skill)
  }
  return skills
}

async function* discoverPiSkills(
  ctx: SourceExecutionContext,
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const root = join(configRoot, 'skills')
  const skills = await loadSkillsWithInstalledPi(ctx, root) ?? await fallbackSkills(root)
  for (const skill of skills) {
    const meta = await safeStat(skill.filePath)
    if (!meta?.isFile()) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'skill', canonicalName: skill.name, displayName: skill.name },
      binding: { path: dirname(skill.filePath), source: 'pi:skills' },
      states: installationOnlyStates(
        skill.filePath,
        observedAt,
        capturedAt,
      ),
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
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return []
    throw error
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
        states: installationOnlyStates(
          extensionPath,
          observedAt,
          capturedAt,
        ),
      }
    }
  }
}

export async function* discoverPiAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  if (ctx.abortSignal.aborted) return

  const resolved = await resolvePiResourceAssets(ctx)
  if (resolved) {
    for (const asset of resolved) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
    return
  }

  const root = ctx.installation.configRoot
  if (!root) return
  const capturedAt = new Date().toISOString()

  // Older/unresolvable SDKs fall back to a deliberately narrow installation-only scan. It never
  // claims project/settings/package coverage or promotes presence into discoverable/enabled=true.
  for (const group of [
    discoverPiSkills(ctx, root, capturedAt),
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
  loadSkillsWithInstalledPi,
}
