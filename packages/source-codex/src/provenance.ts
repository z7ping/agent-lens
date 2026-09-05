import type { ContentProvenance } from '@agent-lens/core'

export type CodexInjectedKind =
  | 'system'
  | 'developer'
  | 'permissions'
  | 'runtime-environment'
  | 'agents'
  | 'skills'
  | 'plugins'
  | 'application'
  | 'transport-echo'
  | 'unknown'

export interface CodexContextClassification {
  kind: CodexInjectedKind
  label: string
  provenance: ContentProvenance
}

function startsWithAny(text: string, values: string[]): boolean {
  const normalized = text.trimStart().toLowerCase()
  return values.some(value => normalized.startsWith(value))
}

function containsAny(text: string, values: string[]): boolean {
  const normalized = text.toLowerCase()
  return values.some(value => normalized.includes(value))
}

export function classifyCodexInjectedKind(role: string, text: string): CodexInjectedKind {
  const nativeRole = role.trim().toLowerCase()
  if (nativeRole === 'system') return 'system'
  if (nativeRole === 'developer') return 'developer'
  if (startsWithAny(text, ['<permissions instructions', '<sandbox_policy', '<approval_policy'])) return 'permissions'
  if (startsWithAny(text, ['<environment_context', '<runtime_context', '<environment '])) return 'runtime-environment'
  if (startsWithAny(text, ['<recommended_plugins', '<plugins', '<plugin_instructions'])
    || containsAny(text.slice(0, 512), ['recommended plugins'])) return 'plugins'
  if (startsWithAny(text, ['<skills', '<skill_instructions'])
    || /^#?\s*skills\b/im.test(text.slice(0, 512))) return 'skills'
  if (startsWithAny(text, ['<agents', '<agent_instructions'])
    || /(^|[\\/])agents\.md\b/i.test(text.slice(0, 1024))
    || /^#\s*agents\.md\b/im.test(text.slice(0, 512))) return 'agents'
  if (nativeRole === 'user') return 'transport-echo'
  if (nativeRole && nativeRole !== 'assistant') return 'application'
  return 'unknown'
}

export function contextClassification(role: string, text: string): CodexContextClassification {
  const kind = classifyCodexInjectedKind(role, text)
  const nativeRole = role || 'unknown'
  if (kind === 'system') {
    return {
      kind,
      label: 'System',
      provenance: {
        contentRole: 'system-context', actualAuthor: 'system', activityType: 'system-injection',
        originType: 'system', sourceSignal: 'response_item.message.role=system', nativeRole,
        injectedKind: kind,
      },
    }
  }
  if (kind === 'developer') {
    return {
      kind,
      label: 'Developer',
      provenance: {
        contentRole: 'developer-context', actualAuthor: 'developer', activityType: 'system-injection',
        originType: 'developer', sourceSignal: 'response_item.message.role=developer', nativeRole,
        injectedKind: kind,
      },
    }
  }
  if (kind === 'runtime-environment') {
    return {
      kind,
      label: '运行环境',
      provenance: {
        contentRole: 'runtime-context', actualAuthor: 'runtime', activityType: 'system-injection',
        originType: 'runtime-environment', sourceSignal: 'response_item.message.runtime-context', nativeRole,
        injectedKind: kind,
      },
    }
  }
  if (kind === 'permissions') {
    return {
      kind,
      label: '权限策略',
      provenance: {
        contentRole: 'system-context', actualAuthor: 'internal-service', activityType: 'system-injection',
        originType: 'internal-service', sourceSignal: 'response_item.message.permissions', nativeRole,
        injectedKind: kind,
      },
    }
  }
  if (kind === 'transport-echo') {
    return {
      kind,
      label: '应用上下文',
      provenance: {
        contentRole: 'application-context', actualAuthor: 'application', activityType: 'transport-echo',
        originType: 'transport-echo', sourceSignal: 'response_item.message.role=user', nativeRole,
        injectedKind: kind, transportEcho: true,
      },
    }
  }
  const label = kind === 'agents'
    ? 'AGENTS'
    : kind === 'skills'
      ? 'Skills'
      : kind === 'plugins'
        ? 'Plugins'
        : '应用注入'
  return {
    kind,
    label,
    provenance: {
      contentRole: 'application-context', actualAuthor: 'application', activityType: 'system-injection',
      originType: 'application-injection', sourceSignal: `response_item.message.${kind}`, nativeRole,
      injectedKind: kind,
    },
  }
}

export function userMessageProvenance(): ContentProvenance {
  return {
    contentRole: 'user-request',
    actualAuthor: 'human-user',
    activityType: 'conversation',
    originType: 'human-user',
    sourceSignal: 'event_msg.user_message',
  }
}

export function assistantMessageProvenance(
  role = 'assistant',
  sourceSignal = 'response_item.message.role=assistant',
): ContentProvenance {
  return {
    contentRole: 'assistant-output',
    actualAuthor: 'assistant',
    activityType: 'conversation',
    originType: 'assistant',
    sourceSignal,
    nativeRole: role,
  }
}

export function attachmentMetadata(payload: Record<string, unknown>): unknown[] {
  const values: unknown[] = []
  for (const key of ['images', 'local_images', 'attachments', 'text_elements']) {
    const value = payload[key]
    if (Array.isArray(value) && value.length) values.push(...value.map(item => ({ kind: key, value: item })))
  }
  return values
}

export function isGuardianSource(value: unknown): boolean {
  const text = JSON.stringify(value ?? '').toLowerCase()
  return text.includes('guardian_review') || text.includes('guardian-review') || text.includes('"guardian"')
}
