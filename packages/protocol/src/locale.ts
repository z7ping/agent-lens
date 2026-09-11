import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface LocalePackDto {
  locale: string
  name: string
  agentLensLocaleVersion: number
  messages: Record<string, string>
}

export interface LocalePackFailureDto {
  fileName: string
  message: string
}

export interface LocalePackListResponseDto {
  items: LocalePackDto[]
  failures: LocalePackFailureDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
