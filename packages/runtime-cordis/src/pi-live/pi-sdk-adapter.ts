import type {
  AgentSession,
  PromptOptions,
  SessionManager,
} from '@earendil-works/pi-coding-agent'

export const PI_SDK_PACKAGE_NAME = '@earendil-works/pi-coding-agent'
export const PI_SDK_TYPE_BASELINE = '0.84.4'
export const PI_SDK_TESTED_MINOR = '0.84'

type OfficialPiModule = typeof import('@earendil-works/pi-coding-agent')
type OfficialPiModel = NonNullable<AgentSession['model']>
type OfficialCreateAgentSessionOptions = NonNullable<Parameters<OfficialPiModule['createAgentSession']>[0]>
type OfficialExtensionBindings = Parameters<AgentSession['bindExtensions']>[0]

export type PiSdkModel = Pick<OfficialPiModel, 'provider' | 'id' | 'name' | 'reasoning'>
export type PiSdkPromptOptions = Pick<PromptOptions, 'streamingBehavior' | 'source' | 'preflightResult'>
export type PiSdkThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0]
export type PiSdkExtensionBindings = OfficialExtensionBindings
export type PiSdkExtensionUiContext = NonNullable<OfficialExtensionBindings['uiContext']>

export interface PiSdkSessionManager {
  getSessionId(): ReturnType<SessionManager['getSessionId']>
  getSessionFile(): ReturnType<SessionManager['getSessionFile']>
  getSessionName(): ReturnType<SessionManager['getSessionName']>
  getLeafId(): ReturnType<SessionManager['getLeafId']>
  getEntries(): unknown[]
}

export interface PiSdkModelRuntime {
  getAvailableSnapshot(): readonly PiSdkModel[]
  getAvailable(providerId?: Parameters<AgentSession['modelRuntime']['getAvailable']>[0]): Promise<readonly PiSdkModel[]>
}

export interface PiSdkSession {
  readonly sessionManager: PiSdkSessionManager
  readonly sessionId: AgentSession['sessionId']
  readonly sessionFile: AgentSession['sessionFile']
  readonly sessionName: AgentSession['sessionName']
  readonly model: PiSdkModel | undefined
  readonly thinkingLevel: AgentSession['thinkingLevel']
  readonly isStreaming: AgentSession['isStreaming']
  readonly isCompacting: AgentSession['isCompacting']
  readonly pendingMessageCount: AgentSession['pendingMessageCount']
  readonly modelRuntime: PiSdkModelRuntime
  bindExtensions(bindings: PiSdkExtensionBindings): ReturnType<AgentSession['bindExtensions']>
  subscribe(listener: Parameters<AgentSession['subscribe']>[0]): ReturnType<AgentSession['subscribe']>
  setSessionName(name: Parameters<AgentSession['setSessionName']>[0]): ReturnType<AgentSession['setSessionName']>
  setModel(model: PiSdkModel): Promise<void>
  setThinkingLevel(level: PiSdkThinkingLevel): ReturnType<AgentSession['setThinkingLevel']>
  getAvailableThinkingLevels(): ReturnType<AgentSession['getAvailableThinkingLevels']>
  prompt(message: Parameters<AgentSession['prompt']>[0], options?: PiSdkPromptOptions): Promise<void>
  steer(message: Parameters<AgentSession['steer']>[0]): ReturnType<AgentSession['steer']>
  followUp(message: Parameters<AgentSession['followUp']>[0]): ReturnType<AgentSession['followUp']>
  clearQueue(): ReturnType<AgentSession['clearQueue']>
  abort(): ReturnType<AgentSession['abort']>
  waitForIdle(): ReturnType<AgentSession['waitForIdle']>
  dispose(): ReturnType<AgentSession['dispose']>
}

export interface PiSdkModule {
  createAgentSession(options: {
    cwd: OfficialCreateAgentSessionOptions['cwd']
    sessionManager: PiSdkSessionManager
  }): Promise<{ session: PiSdkSession }>
  SessionManager: {
    create(...args: Parameters<OfficialPiModule['SessionManager']['create']>): PiSdkSessionManager
    open(...args: Parameters<OfficialPiModule['SessionManager']['open']>): PiSdkSessionManager
  }
}

export interface PiSdkCompatibility {
  packageVersion?: string | undefined
  typeBaseline: string
  testedVersion: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
}

function capabilityTarget(value: unknown): Record<string, unknown> {
  return value && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : {}
}

function functionValue(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

function packageMinor(version: string | undefined): string | undefined {
  const match = version?.trim().match(/^(\d+)\.(\d+)(?:\.|$)/)
  return match ? `${match[1]}.${match[2]}` : undefined
}

export function inspectPiSdkCompatibility(version?: string): PiSdkCompatibility {
  return {
    ...(version ? { packageVersion: version } : {}),
    typeBaseline: PI_SDK_TYPE_BASELINE,
    testedVersion: packageMinor(version) === PI_SDK_TESTED_MINOR,
  }
}

function missingCapabilities(target: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter(name => !functionValue(target[name]))
}

export function assertPiSdkModule(value: unknown, sdkEntry: string, version?: string): PiSdkModule {
  const module = record(value)
  // JavaScript class 的运行时类型是 function；静态方法挂在 class 本身上。
  const sessionManager = capabilityTarget(module.SessionManager)
  const missing = [
    ...missingCapabilities(module, ['createAgentSession']),
    ...missingCapabilities(sessionManager, ['create', 'open']).map(name => `SessionManager.${name}`),
  ]
  if (missing.length) {
    const suffix = version ? ` (${version})` : ''
    throw new Error(
      `Installed Pi SDK${suffix} is missing required capabilities: ${missing.join(', ')}. Entry: ${sdkEntry}`,
    )
  }
  return module as unknown as PiSdkModule
}

export function assertPiSdkSession(value: unknown, sdkEntry: string, version?: string): asserts value is PiSdkSession {
  const session = record(value)
  const manager = record(session.sessionManager)
  const modelRuntime = record(session.modelRuntime)
  const missing = [
    ...missingCapabilities(session, [
      'bindExtensions',
      'subscribe',
      'setSessionName',
      'setModel',
      'setThinkingLevel',
      'getAvailableThinkingLevels',
      'prompt',
      'steer',
      'followUp',
      'clearQueue',
      'abort',
      'dispose',
    ]),
    ...missingCapabilities(manager, ['getSessionId', 'getSessionFile', 'getSessionName', 'getLeafId', 'getEntries'])
      .map(name => `sessionManager.${name}`),
    ...missingCapabilities(modelRuntime, ['getAvailableSnapshot', 'getAvailable'])
      .map(name => `modelRuntime.${name}`),
  ]
  if (missing.length) {
    const suffix = version ? ` (${version})` : ''
    throw new Error(
      `Installed Pi SDK session${suffix} is missing required capabilities: ${missing.join(', ')}. Entry: ${sdkEntry}`,
    )
  }
}

const PI_EXTENSION_UI_METHODS = [
  'select',
  'confirm',
  'input',
  'notify',
  'onTerminalInput',
  'setStatus',
  'setWorkingMessage',
  'setWorkingVisible',
  'setWorkingIndicator',
  'setHiddenThinkingLabel',
  'setWidget',
  'setFooter',
  'setHeader',
  'setTitle',
  'custom',
  'pasteToEditor',
  'setEditorText',
  'getEditorText',
  'editor',
  'addAutocompleteProvider',
  'setEditorComponent',
  'getEditorComponent',
  'getAllThemes',
  'getTheme',
  'setTheme',
  'getToolsExpanded',
  'setToolsExpanded',
] as const

export function asPiSdkExtensionUiContext(value: Record<string, unknown>): PiSdkExtensionUiContext {
  const missing = missingCapabilities(value, PI_EXTENSION_UI_METHODS)
  if (!value.theme || typeof value.theme !== 'object') missing.push('theme')
  if (missing.length) {
    throw new Error(`AgentLens Pi Extension UI bridge is missing required capabilities: ${missing.join(', ')}`)
  }
  return value as unknown as PiSdkExtensionUiContext
}
