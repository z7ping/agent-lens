import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  DiscoveredAsset,
  DiscoveredAssetStateHint,
  EvidenceCandidate,
  SourceExecutionContext,
} from '@agent-lens/core'
import {
  loadInstalledPiSdk,
  resolvePiSdkResourceApi,
  type PiSdkResourceApi,
} from '@agent-lens/runtime-cordis'
import { listJsonlFiles, readJsonlLines } from './session'

type PiResolvedPaths = Awaited<ReturnType<InstanceType<PiSdkResourceApi['DefaultPackageManager']>['resolve']>>
type PiResolvedResource = PiResolvedPaths['skills'][number]
type PiSkill = ReturnType<PiSdkResourceApi['loadSkills']>['skills'][number]
type ProjectTrustState = true | false | 'unknown'
type EffectiveResourceState = boolean | 'unknown'

const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function pathContains(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child))
  return value === ''
    || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileMtime(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString()
  } catch {
    return undefined
  }
}

async function readUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function contextSource(scope: 'user' | 'project', kind: string, cwd?: string): string {
  const context = cwd ? `:${sha256(pathKey(cwd)).slice(0, 12)}` : ''
  return `pi:context:${scope}${context}:${kind}`
}

function contextDefinition(path: string): DiscoveredAsset['definition'] {
  const name = basename(path)
  return {
    type: 'context',
    canonicalName: name,
    displayName: name,
    upstreamIdentity: `pi-context:${sha256(pathKey(path))}`,
  }
}

function observedEvidence(
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

function derivedEvidence(
  path: string,
  capturedAt: string,
  nativeStableId: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'derived',
    sourceLocator: { kind: 'file', path },
    nativeStableId,
    capturedAt,
    confidenceHint: 'high',
  }
}

function effectiveEnabled(configuredEnabled: boolean, trust: ProjectTrustState): EffectiveResourceState {
  if (!configuredEnabled || trust === false) return false
  return trust === 'unknown' ? 'unknown' : true
}

function resourceStates(input: {
  path: string
  observedAt: string
  capturedAt: string
  nativeStableId: string
  configured: boolean
  enabled: EffectiveResourceState
  discoverable: EffectiveResourceState
}): DiscoveredAssetStateHint[] {
  const installedEvidence = observedEvidence(
    input.path,
    input.observedAt,
    input.capturedAt,
    `${input.nativeStableId}:installed`,
  )
  const stateEvidence = (state: 'configured' | 'enabled' | 'discoverable') => derivedEvidence(
    input.path,
    input.capturedAt,
    `${input.nativeStableId}:${state}`,
  )
  return [
    {
      state: 'installed',
      value: true,
      observedAt: input.observedAt,
      evidenceCandidates: [installedEvidence],
    },
    ...(input.configured ? [{
      state: 'configured' as const,
      value: true,
      observedAt: input.capturedAt,
      evidenceCandidates: [stateEvidence('configured')],
    }] : []),
    {
      state: 'enabled',
      value: input.enabled,
      observedAt: input.capturedAt,
      ...(input.enabled === 'unknown' ? {} : { evidenceCandidates: [stateEvidence('enabled')] }),
    },
    {
      state: 'discoverable',
      value: input.discoverable,
      observedAt: input.capturedAt,
      ...(input.discoverable === 'unknown' ? {} : { evidenceCandidates: [stateEvidence('discoverable')] }),
    },
  ]
}

function configuredResource(resource: PiResolvedResource): boolean {
  return resource.metadata.origin === 'package' || resource.metadata.source !== 'auto'
}

function resourceSource(resource: PiResolvedResource, cwd?: string): string {
  const scope = resource.metadata.scope
  const context = cwd && scope === 'project' ? `:${sha256(pathKey(cwd)).slice(0, 12)}` : ''
  return `pi:resource:${scope}${context}:${resource.metadata.origin}:${resource.metadata.source}`
}

function extensionName(path: string): string {
  const base = basename(path, extname(path))
  return base === 'index' ? basename(dirname(path)) : base
}

function resourceForPath(resources: readonly PiResolvedResource[], path: string): PiResolvedResource | undefined {
  const key = pathKey(path)
  return [...resources]
    .sort((a, b) => pathKey(b.path).length - pathKey(a.path).length)
    .find(resource => {
      const resourceKey = pathKey(resource.path)
      return key === resourceKey || pathContains(resource.path, path)
    })
}

function loadSkills(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  resources: readonly PiResolvedResource[],
): PiSkill[] {
  const skillPaths = resources.filter(resource => resource.enabled).map(resource => resource.path)
  if (!skillPaths.length) return []
  try {
    return api.loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills
  } catch {
    return []
  }
}

function discoverableSkillPaths(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  allResources: readonly PiResolvedResource[],
): Set<string> {
  return new Set(loadSkills(api, cwd, agentDir, allResources).map(skill => pathKey(skill.filePath)))
}

function validatedSkills(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  resources: readonly PiResolvedResource[],
): PiSkill[] {
  const values: PiSkill[] = []
  for (const resource of resources) {
    try {
      values.push(...api.loadSkills({
        cwd,
        agentDir,
        skillPaths: [resource.path],
        includeDefaults: false,
      }).skills)
    } catch {
      // Invalid or unreadable resources are not valid Pi skills and remain unclaimed.
    }
  }
  const seen = new Set<string>()
  return values.filter(skill => {
    const key = `${skill.name}\u0000${pathKey(skill.filePath)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface PromptCandidate {
  name: string
  valid: boolean
}

async function promptCandidate(api: PiSdkResourceApi, path: string): Promise<PromptCandidate> {
  const name = basename(path, extname(path))
  if (extname(path).toLowerCase() !== '.md') return { name, valid: false }
  const text = await readUtf8(path)
  if (text === undefined) return { name, valid: false }
  try {
    api.parseFrontmatter(text)
    return { name, valid: true }
  } catch {
    return { name, valid: false }
  }
}

async function selectedPromptPaths(
  api: PiSdkResourceApi,
  resources: readonly PiResolvedResource[],
): Promise<Set<string>> {
  const winners = new Map<string, string>()
  for (const resource of resources) {
    if (!resource.enabled) continue
    const candidate = await promptCandidate(api, resource.path)
    if (!candidate.valid || winners.has(candidate.name)) continue
    winners.set(candidate.name, pathKey(resource.path))
  }
  return new Set(winners.values())
}

async function resolvedPromptsAsAssets(input: {
  api: PiSdkResourceApi
  resources: PiResolvedResource[]
  allResourcesForPrecedence: PiResolvedResource[]
  trust: ProjectTrustState
  capturedAt: string
  projectCwd?: string
}): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  const selected = input.trust === true
    ? await selectedPromptPaths(input.api, input.allResourcesForPrecedence)
    : new Set<string>()

  for (const resource of input.resources) {
    const observedAt = await fileMtime(resource.path)
    if (!observedAt) continue
    const candidate = await promptCandidate(input.api, resource.path)
    const enabled = effectiveEnabled(resource.enabled, input.trust)
    const discoverable = !candidate.valid || enabled === false
      ? false
      : enabled === 'unknown'
        ? 'unknown'
        : selected.has(pathKey(resource.path))

    assets.push({
      definition: {
        type: 'prompt',
        canonicalName: candidate.name,
        displayName: candidate.name,
      },
      binding: {
        path: resource.path,
        source: resourceSource(resource, input.projectCwd),
      },
      states: resourceStates({
        path: resource.path,
        observedAt,
        capturedAt: input.capturedAt,
        nativeStableId: `prompt:${resource.path}:${resourceSource(resource, input.projectCwd)}`,
        configured: configuredResource(resource),
        enabled,
        discoverable,
      }),
    })
  }
  return assets
}

interface ThemeCandidate {
  name: string
  definitelyInvalid: boolean
}

async function themeCandidate(path: string): Promise<ThemeCandidate> {
  const fallback = basename(path, extname(path))
  if (extname(path).toLowerCase() !== '.json') return { name: fallback, definitelyInvalid: true }
  const text = await readUtf8(path)
  if (text === undefined) return { name: fallback, definitelyInvalid: true }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { name: fallback, definitelyInvalid: true }
    }
    const name = (parsed as Record<string, unknown>).name
    return typeof name === 'string' && name.trim()
      ? { name: name.trim(), definitelyInvalid: false }
      : { name: fallback, definitelyInvalid: true }
  } catch {
    return { name: fallback, definitelyInvalid: true }
  }
}

async function resolvedThemesAsAssets(input: {
  resources: PiResolvedResource[]
  trust: ProjectTrustState
  capturedAt: string
  projectCwd?: string
}): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  for (const resource of input.resources) {
    const observedAt = await fileMtime(resource.path)
    if (!observedAt) continue
    const candidate = await themeCandidate(resource.path)
    const enabled = effectiveEnabled(resource.enabled, input.trust)
    // Pi's full Theme schema validator is not a public SDK capability. A valid JSON object with
    // a name is still only a candidate until a real Pi runtime proves that it loaded successfully.
    const discoverable = candidate.definitelyInvalid || enabled === false
      ? false
      : 'unknown'

    assets.push({
      definition: {
        type: 'theme',
        canonicalName: candidate.name,
        displayName: candidate.name,
      },
      binding: {
        path: resource.path,
        source: resourceSource(resource, input.projectCwd),
      },
      states: resourceStates({
        path: resource.path,
        observedAt,
        capturedAt: input.capturedAt,
        nativeStableId: `theme:${resource.path}:${resourceSource(resource, input.projectCwd)}`,
        configured: configuredResource(resource),
        enabled,
        discoverable,
      }),
    })
  }
  return assets
}

async function contextAsset(
  path: string,
  source: string,
  capturedAt: string,
  enabled: EffectiveResourceState,
  discoverable: EffectiveResourceState,
): Promise<DiscoveredAsset | undefined> {
  const observedAt = await fileMtime(path)
  if (!observedAt) return undefined
  return {
    definition: contextDefinition(path),
    binding: { path, source },
    states: resourceStates({
      path,
      observedAt,
      capturedAt,
      nativeStableId: `context:${path}:${source}`,
      configured: false,
      enabled,
      discoverable,
    }),
  }
}

async function globalContextAssets(
  api: PiSdkResourceApi,
  agentDir: string,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  try {
    const rows = api.loadProjectContextFiles({ cwd: agentDir, agentDir })
    for (const row of rows) {
      if (pathKey(dirname(row.path)) !== pathKey(agentDir)) continue
      const asset = await contextAsset(
        row.path,
        contextSource('user', 'agents'),
        capturedAt,
        true,
        true,
      )
      if (asset) assets.push(asset)
    }
  } catch {
    // Context discovery remains independent from package/settings parsing failures.
  }

  for (const name of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const path = resolve(agentDir, name)
    const asset = await contextAsset(
      path,
      contextSource('user', name === 'SYSTEM.md' ? 'system' : 'append-system'),
      capturedAt,
      true,
      'unknown',
    )
    if (asset) assets.push(asset)
  }
  return assets
}

async function projectContextAssets(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  trust: ProjectTrustState,
  capturedAt: string,
): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  try {
    // Pi loads AGENTS/CLAUDE context independently of project trust. The pure SDK helper
    // reproduces filename precedence, ancestor ordering, and linked-worktree shadowing.
    const rows = api.loadProjectContextFiles({ cwd, agentDir })
    for (const row of rows) {
      if (pathKey(dirname(row.path)) === pathKey(agentDir)) continue
      const asset = await contextAsset(
        row.path,
        contextSource('project', 'agents', cwd),
        capturedAt,
        true,
        true,
      )
      if (asset) assets.push(asset)
    }
  } catch {
    // One unreadable context chain must not suppress other resource families.
  }

  for (const name of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
    const path = resolve(cwd, '.pi', name)
    const enabled = effectiveEnabled(true, trust)
    const asset = await contextAsset(
      path,
      contextSource('project', name === 'SYSTEM.md' ? 'system' : 'append-system', cwd),
      capturedAt,
      enabled,
      enabled,
    )
    if (asset) assets.push(asset)
  }
  return assets
}

async function readSessionCwd(filePath: string): Promise<string | undefined> {
  try {
    for await (const line of readJsonlLines(filePath, 0)) {
      if (line.endOffset > MAX_SESSION_HEADER_SCAN_BYTES) return undefined
      if (!line.text.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line.text.replace(/^\uFEFF/, ''))
      } catch {
        if (!line.terminated) return undefined
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const entry = parsed as Record<string, unknown>
      if (entry.type !== 'session') return undefined
      const cwd = typeof entry.cwd === 'string' ? entry.cwd.trim() : ''
      return cwd && isAbsolute(cwd) ? resolve(cwd) : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function listPiProjectCwds(dataRoot: string | undefined): Promise<string[]> {
  if (!dataRoot) return []
  const cwds = new Map<string, string>()
  for (const filePath of await listJsonlFiles(dataRoot)) {
    const cwd = await readSessionCwd(filePath)
    if (!cwd || !await isDirectory(cwd)) continue
    if (!cwds.has(pathKey(cwd))) cwds.set(pathKey(cwd), cwd)
  }
  return [...cwds.values()]
}

async function resolvePaths(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): Promise<PiResolvedPaths> {
  const settingsManager = api.SettingsManager.create(cwd, agentDir, { projectTrusted })
  const packageManager = new api.DefaultPackageManager({ cwd, agentDir, settingsManager })
  // Asset discovery is observational. Missing packages must never be installed as a side effect.
  return packageManager.resolve(async () => 'skip')
}

async function builtInProjectTrust(
  api: PiSdkResourceApi,
  cwd: string,
  agentDir: string,
  globalExtensionsMayOverride: boolean,
): Promise<ProjectTrustState> {
  if (!api.hasTrustRequiringProjectResources(cwd)) return true
  // Pi lets user/global extensions answer project_trust before saved/default trust is consulted.
  // Static discovery must not execute those extensions merely to classify assets.
  if (globalExtensionsMayOverride) return 'unknown'

  const trustStore = new api.ProjectTrustStore(agentDir)
  const saved = trustStore.get(cwd)
  if (saved !== null) return saved

  const globalSettings = api.SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const configured = globalSettings.getDefaultProjectTrust()
  if (configured === 'always') return true
  if (configured === 'never') return false
  // Pi would ask in an interactive invocation. A static AgentLens scan cannot know that answer.
  return 'unknown'
}

async function resolvedSkillsAsAssets(input: {
  api: PiSdkResourceApi
  cwd: string
  agentDir: string
  resources: PiResolvedResource[]
  allResourcesForPrecedence: PiResolvedResource[]
  trust: ProjectTrustState
  capturedAt: string
  projectCwd?: string
}): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  const valid = validatedSkills(input.api, input.cwd, input.agentDir, input.resources)
  const selected = discoverableSkillPaths(
    input.api,
    input.cwd,
    input.agentDir,
    input.allResourcesForPrecedence,
  )

  for (const skill of valid) {
    const resource = resourceForPath(input.resources, skill.filePath)
    if (!resource) continue
    const observedAt = await fileMtime(skill.filePath)
    if (!observedAt) continue
    const enabled = effectiveEnabled(resource.enabled, input.trust)
    const selectedByPi = resource.enabled && selected.has(pathKey(skill.filePath))
    const discoverable = enabled === false
      ? false
      : enabled === 'unknown'
        ? 'unknown'
        : selectedByPi
    const source = resourceSource(resource, input.projectCwd)

    assets.push({
      definition: { type: 'skill', canonicalName: skill.name, displayName: skill.name },
      binding: {
        path: dirname(skill.filePath),
        source,
      },
      states: resourceStates({
        path: skill.filePath,
        observedAt,
        capturedAt: input.capturedAt,
        nativeStableId: `skill:${skill.filePath}:${source}`,
        configured: configuredResource(resource),
        enabled,
        discoverable,
      }),
    })
  }
  return assets
}

async function resolvedExtensionsAsAssets(input: {
  resources: PiResolvedResource[]
  trust: ProjectTrustState
  capturedAt: string
  projectCwd?: string
}): Promise<DiscoveredAsset[]> {
  const assets: DiscoveredAsset[] = []
  for (const resource of input.resources) {
    const observedAt = await fileMtime(resource.path)
    if (!observedAt) continue
    const enabled = effectiveEnabled(resource.enabled, input.trust)
    // PackageManager proves that Pi selected a path, but proving successful extension loading would
    // require executing arbitrary extension code. Keep discoverable unknown unless it is disabled.
    const discoverable: EffectiveResourceState = enabled === false ? false : 'unknown'
    const name = extensionName(resource.path)
    const source = resourceSource(resource, input.projectCwd)
    assets.push({
      definition: {
        type: 'extension',
        canonicalName: name,
        displayName: name,
        upstreamIdentity: `pi-extension:${resource.metadata.scope}:${resource.metadata.source}:${resource.path}`,
      },
      binding: {
        path: resource.path,
        source,
      },
      states: resourceStates({
        path: resource.path,
        observedAt,
        capturedAt: input.capturedAt,
        nativeStableId: `extension:${resource.path}:${source}`,
        configured: configuredResource(resource),
        enabled,
        discoverable,
      }),
    })
  }
  return assets
}

/**
 * Resolve Pi resources through the actual installed Pi package manager. null means the installed
 * SDK is too old or unavailable, allowing the caller to use its conservative filesystem fallback.
 */
export async function resolvePiResourceAssets(
  ctx: SourceExecutionContext,
): Promise<DiscoveredAsset[] | null> {
  const executable = ctx.installation.executable
  const agentDir = ctx.installation.configRoot
  if (!executable || !agentDir || ctx.abortSignal.aborted) return null

  let api: PiSdkResourceApi
  try {
    const installed = await loadInstalledPiSdk(executable)
    const resourceApi = resolvePiSdkResourceApi(installed.module)
    if (!resourceApi) return null
    api = resourceApi
  } catch {
    return null
  }

  const capturedAt = new Date().toISOString()
  const assets: DiscoveredAsset[] = []

  // Context files are a pure Pi SDK discovery path and must not disappear because a package or
  // settings entry is broken.
  assets.push(...await globalContextAssets(api, agentDir, capturedAt))

  // Resolve user scope with project settings disabled. This includes ~/.pi/agent resources,
  // ~/.agents/skills, settings paths and installed user package resources.
  let userPaths: PiResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] }
  try {
    userPaths = await resolvePaths(api, process.cwd(), agentDir, false)
  } catch {
    // Keep independently proven context assets; unresolved configured/package resources remain
    // absent rather than guessed.
  }

  const userSkills = userPaths.skills.filter(resource => resource.metadata.scope === 'user')
  const userExtensions = userPaths.extensions.filter(resource => resource.metadata.scope === 'user')
  const userPrompts = userPaths.prompts.filter(resource => resource.metadata.scope === 'user')
  const userThemes = userPaths.themes.filter(resource => resource.metadata.scope === 'user')

  assets.push(...await resolvedSkillsAsAssets({
    api,
    cwd: process.cwd(),
    agentDir,
    resources: userSkills,
    allResourcesForPrecedence: userSkills,
    trust: true,
    capturedAt,
  }))
  assets.push(...await resolvedExtensionsAsAssets({
    resources: userExtensions,
    trust: true,
    capturedAt,
  }))
  assets.push(...await resolvedPromptsAsAssets({
    api,
    resources: userPrompts,
    allResourcesForPrecedence: userPrompts,
    trust: true,
    capturedAt,
  }))
  assets.push(...await resolvedThemesAsAssets({
    resources: userThemes,
    trust: true,
    capturedAt,
  }))

  const globalExtensionsMayOverrideTrust = userExtensions.some(resource => resource.enabled)
  const projectCwds = await listPiProjectCwds(ctx.installation.dataRoot)
  for (const cwd of projectCwds) {
    if (ctx.abortSignal.aborted) break

    let trust: ProjectTrustState = 'unknown'
    try {
      trust = await builtInProjectTrust(api, cwd, agentDir, globalExtensionsMayOverrideTrust)
    } catch {
      // Corrupt/locked trust state cannot be promoted into either trusted or rejected.
    }

    assets.push(...await projectContextAssets(api, cwd, agentDir, trust, capturedAt))

    try {
      // Resolve the potential trusted view so installed project resources are visible even when
      // current trust is false/unknown. Trust is represented as state, not by hiding files.
      const paths = await resolvePaths(api, cwd, agentDir, true)
      const projectSkills = paths.skills.filter(resource => resource.metadata.scope === 'project')
      const projectExtensions = paths.extensions.filter(resource => resource.metadata.scope === 'project')
      const projectPrompts = paths.prompts.filter(resource => resource.metadata.scope === 'project')
      const projectThemes = paths.themes.filter(resource => resource.metadata.scope === 'project')

      assets.push(...await resolvedSkillsAsAssets({
        api,
        cwd,
        agentDir,
        resources: projectSkills,
        allResourcesForPrecedence: paths.skills,
        trust,
        capturedAt,
        projectCwd: cwd,
      }))
      assets.push(...await resolvedExtensionsAsAssets({
        resources: projectExtensions,
        trust,
        capturedAt,
        projectCwd: cwd,
      }))
      assets.push(...await resolvedPromptsAsAssets({
        api,
        resources: projectPrompts,
        allResourcesForPrecedence: paths.prompts,
        trust,
        capturedAt,
        projectCwd: cwd,
      }))
      assets.push(...await resolvedThemesAsAssets({
        resources: projectThemes,
        trust,
        capturedAt,
        projectCwd: cwd,
      }))
    } catch {
      // One stale/corrupt workspace must not hide resources from other observed Pi projects.
    }
  }

  const dedup = new Map<string, DiscoveredAsset>()
  for (const asset of assets) {
    const path = asset.binding?.path ?? ''
    const source = asset.binding?.source ?? ''
    const key = `${asset.definition.type}\u0000${asset.definition.upstreamIdentity ?? asset.definition.canonicalName}\u0000${path}\u0000${source}`
    dedup.set(key, asset)
  }
  return [...dedup.values()]
}

export const piResourceResolverInternals = {
  readSessionCwd,
  listPiProjectCwds,
  builtInProjectTrust,
  configuredResource,
  effectiveEnabled,
  resourceSource,
  promptCandidate,
  selectedPromptPaths,
  themeCandidate,
  globalContextAssets,
  projectContextAssets,
}
