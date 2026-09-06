import type {
  AgentActor,
  AgentInstallation,
  AgentProduct,
  AssetDefinition,
  CanonicalObservation,
  Evidence,
  Host,
  Interaction,
  LogicalSession,
  ObservationCoverage,
  Project,
  SessionRelationship,
  SourceLocator,
  SourceRecord,
  SourceSession,
  ToolDefinition,
  Workspace,
} from '@agent-lens/core'

type SqliteRow = Record<string, unknown>

const CONFIDENCE = ['exact', 'high', 'medium', 'low', 'unknown'] as const
const RELATIONSHIP_TYPE = ['resume', 'continuation', 'fork', 'branch-task', 'subagent', 'internal-review', 'task-root', 'import-copy', 'related'] as const
const ACTOR_ROLE = ['main-agent', 'subagent', 'worker-agent', 'unknown'] as const
const INTERACTION_TRIGGER = ['user', 'system', 'resume', 'followup', 'background', 'unknown'] as const
const OBSERVATION_KIND = [
  'session.lifecycle',
  'message.user',
  'message.assistant',
  'message.commentary',
  'message.reasoning',
  'model.call',
  'model.changed',
  'thinking.level.changed',
  'tool.call',
  'tool.progress',
  'tool.result',
  'permission.request',
  'permission.response',
  'subagent.spawn',
  'subagent.end',
  'context.compaction',
  'context.summary',
  'context.injected',
  'artifact.action',
  'usage',
  'unknown',
] as const
const CAPTURE_METHOD = ['runtime-hook', 'native-log', 'native-db', 'static-scan', 'external-import'] as const
const DERIVATION = ['observed', 'reported', 'derived', 'estimated', 'inferred'] as const
const COVERAGE_STATUS = ['complete', 'partial', 'unavailable', 'unknown'] as const
const ASSET_TYPE = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'rule', 'builtin', 'unknown'] as const
const TOOL_SOURCE_TYPE = ['builtin', 'mcp', 'plugin', 'extension', 'skill-runtime', 'unknown'] as const
const LOCATOR_KIND = ['file', 'database', 'runtime-hook', 'external'] as const

function rowRecord(value: unknown): SqliteRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite persistence returned a non-object row')
  }
  return value as SqliteRow
}
function requiredString(row: SqliteRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string`)
  return value
}

function optionalString(row: SqliteRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: SqliteRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite row field ${key} must be a finite number`)
  }
  return value
}

function optionalNumber(row: SqliteRow, key: string): number | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite row field ${key} must be a finite number or null`)
  }
  return value
}

function enumString<const T extends readonly string[]>(
  row: SqliteRow,
  key: string,
  allowed: T,
): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`SQLite row field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function parseJson(value: unknown, key: string): unknown {
  if (typeof value !== 'string') throw new TypeError(`SQLite row field ${key} must contain JSON text`)
  try {
    return JSON.parse(value)
  } catch {
    throw new TypeError(`SQLite row field ${key} contains invalid JSON`)
  }
}

function stringArrayJson(row: SqliteRow, key: string): string[] {
  const value = parseJson(row[key], key)
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new TypeError(`SQLite row field ${key} must contain a JSON string array`)
  }
  return value
}

function sourceLocator(value: unknown, key: string): SourceLocator {
  const locator = rowRecord(parseJson(value, key))
  const kind = enumString(locator, 'kind', LOCATOR_KIND)
  const path = optionalString(locator, 'path')
  const offset = optionalNumber(locator, 'offset')
  const rowId = optionalString(locator, 'rowId')
  const table = optionalString(locator, 'table')
  const hookEventId = optionalString(locator, 'hookEventId')
  return {
    kind,
    ...(path === undefined ? {} : { path }),
    ...(offset === undefined ? {} : { offset }),
    ...(rowId === undefined ? {} : { rowId }),
    ...(table === undefined ? {} : { table }),
    ...(hookEventId === undefined ? {} : { hookEventId }),
  }
}

export function sqliteRowId(value: unknown): string {
  return requiredString(rowRecord(value), 'id')
}

export function mapHost(value: unknown): Host {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    platform: requiredString(row, 'platform'),
    arch: requiredString(row, 'arch'),
    createdAt: requiredString(row, 'created_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapProduct(value: unknown): AgentProduct {
  const row = rowRecord(value)
  const vendor = optionalString(row, 'vendor')
  const homepage = optionalString(row, 'homepage')
  return {
    id: requiredString(row, 'id'),
    name: requiredString(row, 'name'),
    ...(vendor === undefined ? {} : { vendor }),
    ...(homepage === undefined ? {} : { homepage }),
  }
}

export function mapInstallation(value: unknown): AgentInstallation {
  const row = rowRecord(value)
  const version = optionalString(row, 'version')
  const executable = optionalString(row, 'executable')
  const configRoot = optionalString(row, 'config_root')
  const dataRoot = optionalString(row, 'data_root')
  return {
    id: requiredString(row, 'id'),
    hostId: requiredString(row, 'host_id'),
    productId: requiredString(row, 'product_id'),
    ...(version === undefined ? {} : { version }),
    ...(executable === undefined ? {} : { executable }),
    ...(configRoot === undefined ? {} : { configRoot }),
    ...(dataRoot === undefined ? {} : { dataRoot }),
    firstSeenAt: requiredString(row, 'first_seen_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapProject(value: unknown): Project {
  const row = rowRecord(value)
  const name = optionalString(row, 'name')
  const repositoryIdentity = optionalString(row, 'repository_identity')
  return {
    id: requiredString(row, 'id'),
    ...(name === undefined ? {} : { name }),
    ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
    createdAt: requiredString(row, 'created_at'),
    lastSeenAt: requiredString(row, 'last_seen_at'),
  }
}

export function mapWorkspace(value: unknown): Workspace {
  const row = rowRecord(value)
  const projectId = optionalString(row, 'project_id')
  const repositoryId = optionalString(row, 'repository_id')
  const worktreeId = optionalString(row, 'worktree_id')
  return {
    id: requiredString(row, 'id'),
    hostId: requiredString(row, 'host_id'),
    ...(projectId === undefined ? {} : { projectId }),
    path: requiredString(row, 'path'),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(worktreeId === undefined ? {} : { worktreeId }),
  }
}

export function mapLogicalSession(value: unknown): LogicalSession {
  const row = rowRecord(value)
  const runtimeProfileId = optionalString(row, 'runtime_profile_id')
  const projectId = optionalString(row, 'project_id')
  const workspaceId = optionalString(row, 'workspace_id')
  const title = optionalString(row, 'title')
  const startedAt = optionalString(row, 'started_at')
  const endedAt = optionalString(row, 'ended_at')
  return {
    id: requiredString(row, 'id'),
    installationId: requiredString(row, 'installation_id'),
    ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(title === undefined ? {} : { title }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

export function mapSourceSession(value: unknown): SourceSession {
  const row = rowRecord(value)
  const runtimeProfileId = optionalString(row, 'runtime_profile_id')
  const logicalSessionId = optionalString(row, 'logical_session_id')
  const nativeParentSessionId = optionalString(row, 'native_parent_session_id')
  return {
    id: requiredString(row, 'id'),
    sourceId: requiredString(row, 'source_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
    nativeSessionId: requiredString(row, 'native_session_id'),
    ...(logicalSessionId === undefined ? {} : { logicalSessionId }),
    ...(nativeParentSessionId === undefined ? {} : { nativeParentSessionId }),
  }
}

export function mapRelationship(value: unknown): SessionRelationship {
  const row = rowRecord(value)
  return {
    id: requiredString(row, 'id'),
    fromSessionId: requiredString(row, 'from_session_id'),
    toSessionId: requiredString(row, 'to_session_id'),
    type: enumString(row, 'type', RELATIONSHIP_TYPE),
    evidenceRefs: stringArrayJson(row, 'evidence_refs_json'),
    confidence: enumString(row, 'confidence', CONFIDENCE),
  }
}

export function mapActor(value: unknown): AgentActor {
  const row = rowRecord(value)
  const logicalSessionId = optionalString(row, 'logical_session_id')
  const parentActorId = optionalString(row, 'parent_actor_id')
  const nativeActorId = optionalString(row, 'native_actor_id')
  return {
    id: requiredString(row, 'id'),
    installationId: requiredString(row, 'installation_id'),
    ...(logicalSessionId === undefined ? {} : { logicalSessionId }),
    ...(parentActorId === undefined ? {} : { parentActorId }),
    role: enumString(row, 'role', ACTOR_ROLE),
    ...(nativeActorId === undefined ? {} : { nativeActorId }),
    evidenceRefs: stringArrayJson(row, 'evidence_refs_json'),
  }
}

export function mapInteraction(value: unknown): Interaction {
  const row = rowRecord(value)
  const startObservationId = optionalString(row, 'start_observation_id')
  const endObservationId = optionalString(row, 'end_observation_id')
  const startedAt = optionalString(row, 'started_at')
  const endedAt = optionalString(row, 'ended_at')
  return {
    id: requiredString(row, 'id'),
    logicalSessionId: requiredString(row, 'logical_session_id'),
    ordinal: requiredNumber(row, 'ordinal'),
    trigger: enumString(row, 'trigger', INTERACTION_TRIGGER),
    ...(startObservationId === undefined ? {} : { startObservationId }),
    ...(endObservationId === undefined ? {} : { endObservationId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

export function mapSourceRecord(value: unknown): SourceRecord {
  const row = rowRecord(value)
  const sourceSessionNativeId = optionalString(row, 'source_session_native_id')
  const nativeId = optionalString(row, 'native_id')
  const sourceSequence = optionalNumber(row, 'source_sequence')
  const occurredAt = optionalString(row, 'occurred_at')
  const fingerprint = optionalString(row, 'fingerprint')
  return {
    id: requiredString(row, 'id'),
    sourceId: requiredString(row, 'source_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(sourceSessionNativeId === undefined ? {} : { sourceSessionNativeId }),
    nativeType: requiredString(row, 'native_type'),
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    capturedAt: requiredString(row, 'captured_at'),
    locator: sourceLocator(row.locator_json, 'locator_json'),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    payload: parseJson(row.payload_json, 'payload_json'),
    parserVersion: requiredString(row, 'parser_version'),
  }
}

export function mapObservation(value: unknown, evidenceRefs: string[] = []): CanonicalObservation {
  const row = rowRecord(value)
  const projectId = optionalString(row, 'project_id')
  const workspaceId = optionalString(row, 'workspace_id')
  const interactionId = optionalString(row, 'interaction_id')
  const actorId = optionalString(row, 'actor_id')
  const nativeEventId = optionalString(row, 'native_event_id')
  const nativeParentEventId = optionalString(row, 'native_parent_event_id')
  const parentObservationId = optionalString(row, 'parent_observation_id')
  const sourceSequence = optionalNumber(row, 'source_sequence')
  const canonicalSequence = optionalNumber(row, 'canonical_sequence')
  const occurredAt = optionalString(row, 'occurred_at')
  return {
    id: requiredString(row, 'id'),
    hostId: requiredString(row, 'host_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(projectId === undefined ? {} : { projectId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    logicalSessionId: requiredString(row, 'logical_session_id'),
    sourceSessionId: requiredString(row, 'source_session_id'),
    ...(interactionId === undefined ? {} : { interactionId }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(nativeEventId === undefined ? {} : { nativeEventId }),
    ...(nativeParentEventId === undefined ? {} : { nativeParentEventId }),
    ...(parentObservationId === undefined ? {} : { parentObservationId }),
    kind: enumString(row, 'kind', OBSERVATION_KIND),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(canonicalSequence === undefined ? {} : { canonicalSequence }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    capturedAt: requiredString(row, 'captured_at'),
    payload: parseJson(row.payload_json, 'payload_json'),
    evidenceRefs,
  }
}

export function mapEvidence(value: unknown): Evidence {
  const row = rowRecord(value)
  const sourceRecordId = optionalString(row, 'source_record_id')
  const parserVersion = optionalString(row, 'parser_version')
  const eventTime = optionalString(row, 'event_time')
  const missingReason = optionalString(row, 'missing_reason')
  return {
    id: requiredString(row, 'id'),
    captureMethod: enumString(row, 'capture_method', CAPTURE_METHOD),
    derivation: enumString(row, 'derivation', DERIVATION),
    confidence: enumString(row, 'confidence', CONFIDENCE),
    ...(sourceRecordId === undefined ? {} : { sourceRecordId }),
    ...(row.source_locator_json == null ? {} : { sourceLocator: sourceLocator(row.source_locator_json, 'source_locator_json') }),
    ...(parserVersion === undefined ? {} : { parserVersion }),
    ...(eventTime === undefined ? {} : { eventTime }),
    capturedAt: requiredString(row, 'captured_at'),
    ...(missingReason === undefined ? {} : { missingReason }),
  }
}

export function mapCoverage(value: unknown): ObservationCoverage {
  const row = rowRecord(value)
  const from = optionalString(row, 'from_time')
  const to = optionalString(row, 'to_time')
  const reason = optionalString(row, 'reason')
  return {
    id: requiredString(row, 'id'),
    subjectType: requiredString(row, 'subject_type'),
    subjectId: requiredString(row, 'subject_id'),
    capability: requiredString(row, 'capability'),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    status: enumString(row, 'status', COVERAGE_STATUS),
    ...(reason === undefined ? {} : { reason }),
    evidenceRefs: stringArrayJson(row, 'evidence_refs_json'),
  }
}

export function mapAssetDefinition(value: unknown): AssetDefinition {
  const row = rowRecord(value)
  const displayName = optionalString(row, 'display_name')
  const upstreamIdentity = optionalString(row, 'upstream_identity')
  return {
    id: requiredString(row, 'id'),
    type: enumString(row, 'type', ASSET_TYPE),
    canonicalName: requiredString(row, 'canonical_name'),
    ...(displayName === undefined ? {} : { displayName }),
    ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }),
  }
}

export function mapTool(value: unknown): ToolDefinition {
  const row = rowRecord(value)
  const displayName = optionalString(row, 'display_name')
  const assetDefinitionId = optionalString(row, 'asset_definition_id')
  const installationId = optionalString(row, 'installation_id')
  const schemaHash = optionalString(row, 'schema_hash')
  return {
    id: requiredString(row, 'id'),
    canonicalName: requiredString(row, 'canonical_name'),
    ...(displayName === undefined ? {} : { displayName }),
    sourceType: enumString(row, 'source_type', TOOL_SOURCE_TYPE),
    ...(assetDefinitionId === undefined ? {} : { assetDefinitionId }),
    ...(installationId === undefined ? {} : { installationId }),
    ...(schemaHash === undefined ? {} : { schemaHash }),
  }
}
