import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SelectMenu } from '../components/ui'
import { listLocalePacks } from './registry'
import { agentLensI18n, setLocale } from './runtime'

export function LocaleSelector() {
  const { t } = useTranslation('settings')
  const [saving, setSaving] = useState(false)
  const packs = listLocalePacks()
  const current = agentLensI18n.resolvedLanguage ?? agentLensI18n.language

  return <div className="workspace-locale-selector">
    <span>
      <b>{t('language')}</b>
      <small>{t('languageDescription')}</small>
    </span>
    <SelectMenu
      value={packs.some(pack => pack.locale === current) ? current : 'zh-CN'}
      options={packs.map(pack => ({
        value: pack.locale,
        label: pack.name,
        description: pack.locale,
      }))}
      ariaLabel={t('language')}
      variant="toolbar"
      disabled={saving}
      onChange={locale => {
        setSaving(true)
        void setLocale(locale).finally(() => setSaving(false))
      }}
      menuWidth={240}
    />
  </div>
}
