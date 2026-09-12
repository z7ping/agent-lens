import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listLocalePacks } from './registry'
import { agentLensI18n, setLocale } from './runtime'

export function LocaleSelector() {
  const { t } = useTranslation('settings')
  const [saving, setSaving] = useState(false)
  const packs = listLocalePacks()
  const current = agentLensI18n.resolvedLanguage ?? agentLensI18n.language

  return <label className="workspace-locale-selector">
    <span>
      <b>{t('language')}</b>
      <small>{t('languageDescription')}</small>
    </span>
    <select
      value={packs.some(pack => pack.locale === current) ? current : 'zh-CN'}
      disabled={saving}
      onChange={event => {
        const locale = event.target.value
        setSaving(true)
        void setLocale(locale).finally(() => setSaving(false))
      }}
    >
      {packs.map(pack => <option key={pack.locale} value={pack.locale}>
        {pack.name} · {pack.locale}
      </option>)}
    </select>
  </label>
}
