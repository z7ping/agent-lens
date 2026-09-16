import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentOverviewDto,
  CapturePolicyResponseDto,
} from '@agent-lens/protocol'

export function LegacySourceCaptureControl({
  agent,
  policy,
  onChange,
}: {
  agent: AgentOverviewDto
  policy: CapturePolicyResponseDto | null
  onChange(sourceId: string, enabled: boolean): Promise<void>
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const settings = policy?.settings
  const configured = settings?.configuredEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const effective = settings?.effectiveEnabledSources.includes(agent.sourceId) ?? agent.enabled
  const pending = configured !== effective
  const editable = settings?.editable ?? false
  const managedBy = settings?.managedBy

  const toggle = async () => {
    if (!editable || saving) return
    setSaving(true)
    setError('')
    try {
      await onChange(agent.sourceId, !configured)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <section className="source-capture-control source-capture-control-legacy">
    <div>
      <h3>{t('observation.dataCapture')}</h3>
      {pending && <p className="source-capture-note">{configured ? t('integration.pendingEnabled') : t('integration.pendingDisabled')}</p>}
      {!editable && managedBy && <p className="source-capture-note">{t('integration.managedReadonly', {
        manager: managedBy === 'environment' ? t('integration.environmentManager') : t('integration.runtimeManager'),
      })}</p>}
      {error && <p className="source-capture-error">{error}</p>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={configured}
      className="source-capture-switch"
      data-enabled={configured || undefined}
      disabled={!editable || saving}
      onClick={() => void toggle()}
    ><span aria-hidden="true"/><b>{saving ? t('integration.saving') : configured ? t('integration.enabled') : t('integration.disabled')}</b></button>
  </section>
}
