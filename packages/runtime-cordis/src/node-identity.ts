import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context, Plugin } from '@deepseek-ai/cordis'

export const NODE_IDENTITY_SCHEMA_VERSION = 1 as const
export const DEFAULT_AGENT_LENS_PROFILE = 'standalone' as const

export type AgentLensRuntimeProfile = 'standalone' | 'node' | 'hub' | 'pure-hub'

export interface AgentLensNodeIdentity {
  schemaVersion: typeof NODE_IDENTITY_SCHEMA_VERSION
  nodeId: string
  createdAt: string
}

export interface AgentLensNodeCapabilities {
  localCapture: boolean
  replicationUpstream: boolean
  hubAccept: boolean
}

export interface AgentLensNodeRuntime {
  dataRoot: string
  identity: AgentLensNodeIdentity
  profile: AgentLensRuntimeProfile
  capabilities: AgentLensNodeCapabilities
}

export interface LoadOrCreateNodeIdentityOptions {
  randomId?: () => string
  now?: () => Date
}

export interface ResolveAgentLensNodeRuntimeOptions {
  dataRoot?: string
  profile?: AgentLensRuntimeProfile
  identity?: LoadOrCreateNodeIdentityOptions
}

const PROFILE_CAPABILITIES: Record<AgentLensRuntimeProfile, AgentLensNodeCapabilities> = {
  standalone: {
    localCapture: true,
    replicationUpstream: false,
    hubAccept: false,
  },
  node: {
    localCapture: true,
    replicationUpstream: true,
    hubAccept: false,
  },
  hub: {
    localCapture: true,
    replicationUpstream: false,
    hubAccept: true,
  },
  'pure-hub': {
    localCapture: false,
    replicationUpstream: false,
    hubAccept: true,
  },
}

export function defaultAgentLensDataRoot(home = homedir()): string {
  return join(home, '.agent-lens', '1.0')
}

export function nodeIdentityPath(dataRoot: string): string {
  return join(dataRoot, 'node.json')
}

export function assertNodeCapabilities(
  capabilities: AgentLensNodeCapabilities,
): AgentLensNodeCapabilities {
  if (!capabilities.localCapture && !capabilities.replicationUpstream && !capabilities.hubAccept) {
    throw new Error('AgentLens runtime cannot disable all capabilities')
  }
  if (capabilities.replicationUpstream && capabilities.hubAccept) {
    throw new Error('AgentLens Alpha does not allow replicationUpstream + hubAccept')
  }
  if (!capabilities.localCapture && capabilities.replicationUpstream) {
    throw new Error('AgentLens Alpha does not allow replicationUpstream without localCapture')
  }
  return capabilities
}

export function capabilitiesForProfile(
  profile: AgentLensRuntimeProfile,
): AgentLensNodeCapabilities {
  return assertNodeCapabilities({ ...PROFILE_CAPABILITIES[profile] })
}

export function resolveAgentLensRuntimeProfile(
  value: string | undefined = process.env.AGENT_LENS_PROFILE,
): AgentLensRuntimeProfile {
  const profile = value?.trim().toLowerCase() || DEFAULT_AGENT_LENS_PROFILE
  if (profile === 'standalone' || profile === 'node' || profile === 'hub' || profile === 'pure-hub') {
    return profile
  }
  throw new Error(`Unknown AGENT_LENS_PROFILE: ${value}`)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function parseNodeIdentity(content: string, path: string): AgentLensNodeIdentity {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error(`Invalid AgentLens node identity JSON: ${path}`)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid AgentLens node identity document: ${path}`)
  }

  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== NODE_IDENTITY_SCHEMA_VERSION
    || typeof record.nodeId !== 'string'
    || !isUuid(record.nodeId)
    || typeof record.createdAt !== 'string'
    || Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new Error(`Invalid AgentLens node identity document: ${path}`)
  }

  return {
    schemaVersion: NODE_IDENTITY_SCHEMA_VERSION,
    nodeId: record.nodeId,
    createdAt: record.createdAt,
  }
}

function readNodeIdentity(path: string): AgentLensNodeIdentity | null {
  try {
    return parseNodeIdentity(readFileSync(path, 'utf8'), path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function loadOrCreateNodeIdentity(
  dataRoot: string,
  options: LoadOrCreateNodeIdentityOptions = {},
): AgentLensNodeIdentity {
  const path = nodeIdentityPath(dataRoot)
  const existing = readNodeIdentity(path)
  if (existing) return existing

  mkdirSync(dataRoot, { recursive: true })
  const created: AgentLensNodeIdentity = {
    schemaVersion: NODE_IDENTITY_SCHEMA_VERSION,
    nodeId: (options.randomId ?? randomUUID)(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  }

  if (!isUuid(created.nodeId)) {
    throw new Error('Generated AgentLens nodeId is not a UUID')
  }

  try {
    writeFileSync(path, `${JSON.stringify(created, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return created
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readNodeIdentity(path)
    if (!raced) throw new Error(`AgentLens node identity disappeared during initialization: ${path}`)
    return raced
  }
}

export function resolveAgentLensNodeRuntime(
  options: ResolveAgentLensNodeRuntimeOptions = {},
): AgentLensNodeRuntime {
  const dataRoot = options.dataRoot ?? defaultAgentLensDataRoot()
  const profile = options.profile ?? resolveAgentLensRuntimeProfile()
  return {
    dataRoot,
    identity: loadOrCreateNodeIdentity(dataRoot, options.identity),
    profile,
    capabilities: capabilitiesForProfile(profile),
  }
}

const applyNodeRuntime: Plugin.Function<AgentLensNodeRuntime> = (
  ctx: Context,
  runtime: AgentLensNodeRuntime,
) => {
  ctx.provide('node', runtime)
}

/** Internal runtime composition service; it does not introduce a second plugin model. */
export const nodeRuntimePlugin = applyNodeRuntime
