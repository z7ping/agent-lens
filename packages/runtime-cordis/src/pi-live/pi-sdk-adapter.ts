import type {
  AgentSession,
  PromptOptions,
  SessionManager,
} from '@earendil-works/pi-coding-agent'

export const PI_SDK_PACKAGE_NAME = '@earendil-works/pi-coding-agent'
export const PI_SDK_TYPE_BASELINE = '0.84.4'
export const PI_SDK_TESTED_MINOR = '0.84'

export type PiSdkSession = AgentSession
export type PiSdkSessionManager = SessionManager
export type PiSdkPromptOptions = PromptOptions
export type PiSdkModel = NonNullable<AgentSession['model']>
export type PiSdkModelRuntime = AgentSession['modelRuntime']
export type PiSdkThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0]
export type PiSdkModule = Pick<
  typeof import('@earendil-works/pi-coding-agent'),
  'createAgentSession' | 'SessionManager'
>

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
  const sessionManager = record(module.SessionManager)
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
  return module as PiSdkModule
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
