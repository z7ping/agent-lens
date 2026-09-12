import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, UiIcon } from '../components/ui'
import { listLocalePacks } from './registry'
import { agentLensI18n, setLocale } from './runtime'

export function LocaleSelector() {
  const { t } = useTranslation('settings')
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const packs = listLocalePacks()
  const current = agentLensI18n.resolvedLanguage ?? agentLensI18n.language
  const selected = packs.find(pack => pack.locale === current) ?? packs.find(pack => pack.locale === 'zh-CN') ?? packs[0]

  const chooseLocale = (locale: string) => {
    if (locale === selected?.locale) {
      setOpen(false)
      return
    }
    setSaving(true)
    void setLocale(locale)
      .then(() => setOpen(false))
      .finally(() => setSaving(false))
  }

  return <>
    <button
      ref={anchorRef}
      type="button"
      className="workspace-settings-menu-item workspace-locale-trigger"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={saving}
      onClick={() => setOpen(currentOpen => !currentOpen)}
    >
      <UiIcon name="language" size={14}/>
      <span>{t('language')}</span>
      <span className="workspace-settings-menu-value">{selected?.name ?? t('language')}</span>
      <UiIcon className="workspace-settings-menu-tail" name="chevron-right" size={14}/>
    </button>
    <Popover
      open={open}
      anchorRef={anchorRef}
      onClose={() => setOpen(false)}
      placement="right-end"
      className="workspace-locale-popover"
    >
      <div className="workspace-locale-popover-title">{t('language')}</div>
      <div className="workspace-locale-options" role="menu" aria-label={t('language')}>
        {packs.map(pack => {
          const active = pack.locale === selected?.locale
          return <button
            key={pack.locale}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            disabled={saving}
            className={`workspace-locale-option ${active ? 'is-active' : ''}`}
            onClick={() => chooseLocale(pack.locale)}
          >
            <span>
              <b>{pack.name}</b>
              <small>{pack.locale}</small>
            </span>
            {active && <UiIcon name="check" size={15}/>}
          </button>
        })}
      </div>
    </Popover>
  </>
}
