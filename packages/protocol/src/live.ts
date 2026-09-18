export interface LiveTextPartDto {
  type: 'text'
  text: string
}

export interface LiveLargeTextPartDto {
  type: 'large-text'
  text: string
  lineCount?: number | undefined
  charCount?: number | undefined
}

export interface LiveAttachmentDescriptorDto {
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes: number
}

export interface LiveAttachmentPartDto {
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes?: number | undefined
}

export interface LiveImagePartDto extends LiveAttachmentPartDto {
  type: 'image'
}

export interface LiveFilePartDto extends LiveAttachmentPartDto {
  type: 'file'
}

export type LiveMessagePartDto =
  | LiveTextPartDto
  | LiveLargeTextPartDto
  | LiveImagePartDto
  | LiveFilePartDto

export interface LiveMessageDto {
  parts: LiveMessagePartDto[]
}

export type LiveMessageInputDto = string | LiveMessageDto

export type LiveCapabilityNameDto =
  | 'create'
  | 'resume'
  | 'fork'
  | 'send'
  | 'stream'
  | 'interrupt'
  | 'queue'
  | 'steer'
  | 'model-switching'
  | 'thinking-control'
  | 'extension-ui'
  | 'command-discovery'
  | 'workspace-file-reference'
  | 'recovery'

export type LiveInputSupportDto = 'native' | 'transform' | 'unsupported'
export type LiveStartFieldSupportDto = 'required' | 'optional' | 'unsupported'

export interface LiveInputCapabilitiesDto {
  text: LiveInputSupportDto
  largeText: LiveInputSupportDto
  image: LiveInputSupportDto
  file: LiveInputSupportDto
  multiline: LiveInputSupportDto
}

export interface LiveStartInputDto {
  workspacePath?: string | undefined
  title?: string | undefined
}

export interface LiveStartCapabilitiesDto {
  workspace: LiveStartFieldSupportDto
  title: LiveStartFieldSupportDto
}

export interface LiveAvailabilityDto {
  available: boolean
  reason?: string | undefined
}

export type LiveRuntimeStatusDto = 'initializing' | 'ready' | 'failed' | 'terminating' | 'terminated'

export interface LiveRuntimeStateDto {
  runtimeSessionId: string
  status: LiveRuntimeStatusDto
  nativeSessionId?: string | undefined
  workspacePath?: string | undefined
  isStreaming: boolean
  pendingMessageCount: number
}

export interface LiveSnapshotDto {
  state: LiveRuntimeStateDto
  entries: unknown[]
  leafId?: string | null | undefined
}

export interface LiveQueueStateDto {
  steering: string[]
  followUp: string[]
}

export interface LiveInterruptResultDto {
  restoredQueue?: LiveQueueStateDto | undefined
}

export interface LiveRuntimeEventDto {
  runtimeSessionId: string
  sequence: number
  receivedAt: string
  event: Readonly<Record<string, unknown>>
  normalizedEvent?: Readonly<LiveEventDto> | undefined
}

export interface LiveProductDto {
  liveId: string
  productId: string
  displayName: string
  capabilities: LiveCapabilityNameDto[]
  inputCapabilities: LiveInputCapabilitiesDto
  startCapabilities: LiveStartCapabilitiesDto
  availability: LiveAvailabilityDto
  runtimes: LiveRuntimeStateDto[]
}

export interface LiveProductsResponseDto {
  items: LiveProductDto[]
}

export interface LiveRuntimeRefDto {
  liveId: string
  productId: string
  displayName: string
  state: LiveRuntimeStateDto
}

export type LiveEventStatusDto =
  | 'initializing'
  | 'ready'
  | 'running'
  | 'idle'
  | 'compacting'
  | 'failed'
  | 'terminating'
  | 'terminated'

export type LiveCompletionStatusDto = 'completed' | 'cancelled' | 'interrupted' | 'failed'

export type LiveEventDto =
  | { type: 'status'; status: LiveEventStatusDto; message?: string | undefined }
  | {
      type: 'message.start' | 'message.end'
      role?: 'user' | 'assistant' | 'tool' | 'system' | 'unknown' | undefined
      messageId?: string | undefined
    }
  | {
      type:
        | 'text.start'
        | 'text.delta'
        | 'text.end'
        | 'reasoning.start'
        | 'reasoning.delta'
        | 'reasoning.end'
      text?: string | undefined
      delta?: string | undefined
      messageId?: string | undefined
      contentIndex?: number | undefined
    }
  | {
      type: 'tool.start'
      callId?: string | undefined
      name: string
      inputPreview?: string | undefined
      contentIndex?: number | undefined
    }
  | { type: 'tool.output'; callId?: string | undefined; name?: string | undefined; output: string }
  | {
      type: 'tool.end'
      callId?: string | undefined
      name?: string | undefined
      status: 'success' | 'error'
      output?: string | undefined
      durationMs?: number | undefined
    }
  | {
      type: 'queue.update'
      steering: string[]
      followUp: string[]
    }
  | {
      type: 'ui.request'
      requestId: string
      method: 'select' | 'confirm' | 'input' | 'editor'
      title?: string | undefined
      message?: string | undefined
      options?: string[] | undefined
      placeholder?: string | undefined
      prefill?: string | undefined
    }
  | { type: 'error'; message: string }
  | { type: 'completed'; status: LiveCompletionStatusDto; message?: string | undefined }

export interface LiveControlDisplayInfoDto {
  label?: string | undefined
  description?: string | undefined
}

export interface LiveControlOptionDto extends LiveControlDisplayInfoDto {
  /** Runtime-owned opaque value; surfaces must round-trip it unchanged. */
  value: string
}

export interface LiveCommandDto extends LiveControlDisplayInfoDto {
  value: string
  group?: string | undefined
}

export interface LiveCommandsResponseDto {
  items: LiveCommandDto[]
}

export interface LiveWorkspaceFileReferenceDto {
  path: string
  value: string
}

export interface LiveWorkspaceFileReferencesResponseDto {
  items: LiveWorkspaceFileReferenceDto[]
}

export interface LiveContributionTextDto {
  default: string
  localizations?: Record<string, string> | undefined
}

export interface LiveMessageActionContributionDto {
  actionId: string
  label: LiveContributionTextDto
  description?: LiveContributionTextDto | undefined
  roles: Array<'user' | 'assistant'>
  requiresIdle?: boolean | undefined
}

export interface LiveMessageActionsResponseDto {
  items: LiveMessageActionContributionDto[]
}

export interface LiveMessageActionRequestDto {
  actionId: string
  targetEntryId: string
}

export interface LiveMessageActionResultDto {
  outcome: 'refresh-current' | 'open-runtime'
  runtime?: LiveRuntimeStateDto | undefined
  draftText?: string | undefined
}


export type LiveContributionToneDto = 'neutral' | 'info' | 'warning' | 'danger'
export type LiveContributionActionToneDto = 'default' | 'primary' | 'danger'
export type LiveRuntimeContributionFieldKindDto = 'text' | 'list' | 'code'

export interface LiveRuntimeContributionFieldDto {
  label: LiveContributionTextDto
  kind?: LiveRuntimeContributionFieldKindDto | undefined
  value?: string | undefined
  values?: string[] | undefined
}

export interface LiveRuntimeActionContributionDto {
  actionId: string
  label: LiveContributionTextDto
  description?: LiveContributionTextDto | undefined
  tone?: LiveContributionActionToneDto | undefined
}

export interface LiveRuntimeDisclosureContributionDto {
  contributionId: string
  title: LiveContributionTextDto
  summary?: LiveContributionTextDto | undefined
  tone?: LiveContributionToneDto | undefined
  defaultExpanded?: boolean | undefined
  fields: LiveRuntimeContributionFieldDto[]
  actions?: LiveRuntimeActionContributionDto[] | undefined
}

export interface LiveRuntimeDisclosuresResponseDto {
  items: LiveRuntimeDisclosureContributionDto[]
}

export interface LiveRuntimeActionRequestDto {
  actionId: string
}

export interface LiveRuntimeActionResultDto {
  runtime: LiveRuntimeStateDto
}

export interface LiveThinkingControlDto extends LiveControlDisplayInfoDto {
  capability: 'thinking-control'
  value: string
  options: LiveControlOptionDto[]
}

export interface LiveModelControlDto extends LiveControlDisplayInfoDto {
  capability: 'model-switching'
  value?: string | undefined
  options: LiveControlOptionDto[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function parseLiveMessagePartDto(value: unknown): LiveMessagePartDto {
  const part = record(value)
  if (!part || typeof part.type !== 'string') {
    throw new TypeError('Live message part must be an object with type')
  }
  if (part.type === 'text') {
    if (typeof part.text !== 'string') throw new TypeError('Live text part requires text')
    return { type: 'text', text: part.text }
  }
  if (part.type === 'large-text') {
    if (typeof part.text !== 'string') throw new TypeError('Live large-text part requires text')
    const lineCount = optionalCount(part.lineCount)
    const charCount = optionalCount(part.charCount)
    if (lineCount === null) throw new TypeError('Live large-text lineCount must be a non-negative integer')
    if (charCount === null) throw new TypeError('Live large-text charCount must be a non-negative integer')
    return {
      type: 'large-text',
      text: part.text,
      ...(lineCount !== undefined ? { lineCount } : {}),
      ...(charCount !== undefined ? { charCount } : {}),
    }
  }
  if (part.type === 'image' || part.type === 'file') {
    if (typeof part.attachmentId !== 'string' || !part.attachmentId.trim()) {
      throw new TypeError(`Live ${part.type} part requires attachmentId`)
    }
    const name = optionalText(part.name)
    const mimeType = optionalText(part.mimeType)
    const sizeBytes = optionalCount(part.sizeBytes)
    if (name === null) throw new TypeError(`Live ${part.type} name must be a string`)
    if (mimeType === null) throw new TypeError(`Live ${part.type} mimeType must be a string`)
    if (sizeBytes === null) throw new TypeError(`Live ${part.type} sizeBytes must be a non-negative integer`)
    return {
      type: part.type,
      attachmentId: part.attachmentId,
      ...(name !== undefined ? { name } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    }
  }
  throw new TypeError(`Unsupported Live message part type: ${part.type}`)
}

export function parseLiveMessageInputDto(value: unknown): LiveMessageDto {
  if (typeof value === 'string') {
    return { parts: [{ type: 'text', text: value }] }
  }
  const message = record(value)
  if (!message || !Array.isArray(message.parts)) {
    throw new TypeError('Live message must be a string or an object with parts')
  }
  return { parts: message.parts.map(parseLiveMessagePartDto) }
}

export function liveMessagePlainTextDto(message: LiveMessageDto): string {
  const blocks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text' || part.type === 'large-text') {
      blocks.push(part.text)
      continue
    }
    throw new TypeError(`Live attachment part requires adapter transformation: ${part.type}`)
  }
  return blocks.join('\n\n')
}

const LIVE_EVENT_STATUSES = new Set<LiveEventStatusDto>([
  'initializing',
  'ready',
  'running',
  'idle',
  'compacting',
  'failed',
  'terminating',
  'terminated',
])

const LIVE_COMPLETION_STATUSES = new Set<LiveCompletionStatusDto>([
  'completed',
  'cancelled',
  'interrupted',
  'failed',
])

function eventText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function eventCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseLiveEventDto(value: unknown): LiveEventDto | null {
  const event = record(value)
  if (!event || typeof event.type !== 'string') return null
  const type = event.type

  if (type === 'status') {
    const status = event.status
    if (typeof status !== 'string' || !LIVE_EVENT_STATUSES.has(status as LiveEventStatusDto)) return null
    return {
      type,
      status: status as LiveEventStatusDto,
      ...(eventText(event.message) !== undefined ? { message: eventText(event.message) } : {}),
    }
  }
  if (type === 'message.start' || type === 'message.end') {
    const role = event.role
    const validRole = role === undefined
      || role === 'user' || role === 'assistant' || role === 'tool' || role === 'system' || role === 'unknown'
    if (!validRole) return null
    return {
      type,
      ...(role === undefined ? {} : { role }),
      ...(eventText(event.messageId) !== undefined ? { messageId: eventText(event.messageId) } : {}),
    }
  }
  if (type === 'text.start' || type === 'text.delta' || type === 'text.end'
    || type === 'reasoning.start' || type === 'reasoning.delta' || type === 'reasoning.end') {
    const contentIndex = eventCount(event.contentIndex)
    return {
      type,
      ...(eventText(event.text) !== undefined ? { text: eventText(event.text) } : {}),
      ...(eventText(event.delta) !== undefined ? { delta: eventText(event.delta) } : {}),
      ...(eventText(event.messageId) !== undefined ? { messageId: eventText(event.messageId) } : {}),
      ...(contentIndex !== undefined ? { contentIndex } : {}),
    }
  }
  if (type === 'tool.start') {
    if (typeof event.name !== 'string' || !event.name) return null
    const contentIndex = eventCount(event.contentIndex)
    return {
      type,
      name: event.name,
      ...(eventText(event.callId) !== undefined ? { callId: eventText(event.callId) } : {}),
      ...(eventText(event.inputPreview) !== undefined ? { inputPreview: eventText(event.inputPreview) } : {}),
      ...(contentIndex !== undefined ? { contentIndex } : {}),
    }
  }
  if (type === 'tool.output') {
    if (typeof event.output !== 'string') return null
    return {
      type,
      output: event.output,
      ...(eventText(event.callId) !== undefined ? { callId: eventText(event.callId) } : {}),
      ...(eventText(event.name) !== undefined ? { name: eventText(event.name) } : {}),
    }
  }
  if (type === 'tool.end') {
    if (event.status !== 'success' && event.status !== 'error') return null
    const durationMs = eventCount(event.durationMs)
    return {
      type,
      status: event.status,
      ...(eventText(event.callId) !== undefined ? { callId: eventText(event.callId) } : {}),
      ...(eventText(event.name) !== undefined ? { name: eventText(event.name) } : {}),
      ...(eventText(event.output) !== undefined ? { output: eventText(event.output) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }
  }
  if (type === 'queue.update') {
    const rawSteering = event.steering
    const rawFollowUp = event.followUp
    if (!Array.isArray(rawSteering) || !Array.isArray(rawFollowUp)) return null
    const steering = rawSteering.filter((item): item is string => typeof item === 'string')
    const followUp = rawFollowUp.filter((item): item is string => typeof item === 'string')
    if (steering.length !== rawSteering.length || followUp.length !== rawFollowUp.length) return null
    return { type, steering, followUp }
  }
  if (type === 'ui.request') {
    if (typeof event.requestId !== 'string' || !event.requestId) return null
    if (event.method !== 'select' && event.method !== 'confirm' && event.method !== 'input' && event.method !== 'editor') return null
    const rawOptions = event.options
    if (rawOptions !== undefined && (!Array.isArray(rawOptions) || rawOptions.some(option => typeof option !== 'string'))) return null
    const options = Array.isArray(rawOptions) ? rawOptions as string[] : undefined
    const title = eventText(event.title)
    const message = eventText(event.message)
    const placeholder = eventText(event.placeholder)
    const prefill = eventText(event.prefill)
    return {
      type,
      requestId: event.requestId,
      method: event.method,
      ...(title !== undefined ? { title } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(options !== undefined ? { options: [...options] } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(prefill !== undefined ? { prefill } : {}),
    }
  }
  if (type === 'error') {
    return typeof event.message === 'string' && event.message ? { type, message: event.message } : null
  }
  if (type === 'completed') {
    const status = event.status
    if (typeof status !== 'string' || !LIVE_COMPLETION_STATUSES.has(status as LiveCompletionStatusDto)) return null
    return {
      type,
      status: status as LiveCompletionStatusDto,
      ...(eventText(event.message) !== undefined ? { message: eventText(event.message) } : {}),
    }
  }
  return null
}

export function parseLiveThinkingControlDto(value: unknown): LiveThinkingControlDto | null {
  const control = record(value)
  if (!control || control.capability !== 'thinking-control') return null
  if (typeof control.value !== 'string' || !control.value) return null
  if (!Array.isArray(control.options) || control.options.length === 0) return null

  const label = optionalText(control.label)
  const description = optionalText(control.description)
  if (label === null || description === null) return null

  const options: LiveControlOptionDto[] = []
  let hasCurrent = false
  for (const candidate of control.options) {
    const option = record(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return null
    const optionLabel = optionalText(option.label)
    const optionDescription = optionalText(option.description)
    if (optionLabel === null || optionDescription === null) return null
    if (option.value === control.value) hasCurrent = true
    options.push({
      value: option.value,
      ...(optionLabel !== undefined ? { label: optionLabel } : {}),
      ...(optionDescription !== undefined ? { description: optionDescription } : {}),
    })
  }
  if (!hasCurrent) return null

  return {
    capability: 'thinking-control',
    value: control.value,
    options,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}


export function parseLiveModelControlDto(value: unknown): LiveModelControlDto | null {
  const control = record(value)
  if (!control || control.capability !== 'model-switching') return null
  if (control.value !== undefined && (typeof control.value !== 'string' || !control.value)) return null
  if (!Array.isArray(control.options) || control.options.length === 0) return null

  const label = optionalText(control.label)
  const description = optionalText(control.description)
  if (label === null || description === null) return null

  const options: LiveControlOptionDto[] = []
  let hasCurrent = control.value === undefined
  for (const candidate of control.options) {
    const option = record(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return null
    const optionLabel = optionalText(option.label)
    const optionDescription = optionalText(option.description)
    if (optionLabel === null || optionDescription === null) return null
    if (option.value === control.value) hasCurrent = true
    options.push({
      value: option.value,
      ...(optionLabel !== undefined ? { label: optionLabel } : {}),
      ...(optionDescription !== undefined ? { description: optionDescription } : {}),
    })
  }
  if (!hasCurrent) return null

  return {
    capability: 'model-switching',
    ...(typeof control.value === 'string' ? { value: control.value } : {}),
    options,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
  }
}
