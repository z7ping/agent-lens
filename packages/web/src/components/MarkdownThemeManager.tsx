import { useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { readMarkdownTheme, subscribeMarkdownTheme, writeMarkdownTheme } from '../client/preferences'
import { DEFAULT_MARKDOWN_THEME, type CustomMarkdownThemeId, type MarkdownThemeId } from './markdown-theme'
import {
  importCustomMarkdownTheme,
  MarkdownThemeImportError,
  removeCustomMarkdownTheme,
  useCustomMarkdownThemes,
} from './markdown-theme-registry'
import { Button, Dialog, StatusBadge, UiIcon } from './ui'

interface MarkdownThemeManagerProps {
  open: boolean
  onClose(): void
}

export function MarkdownThemeManager({ open, onClose }: MarkdownThemeManagerProps) {
  const { t } = useTranslation('settings')
  const inputRef = useRef<HTMLInputElement>(null)
  const currentTheme = useSyncExternalStore(subscribeMarkdownTheme, readMarkdownTheme, readMarkdownTheme)
  const customThemes = useCustomMarkdownThemes()
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)

  const selectTheme = (id: MarkdownThemeId) => {
    writeMarkdownTheme(id)
    setNotice(null)
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImporting(true)
    setNotice(null)
    try {
      const theme = await importCustomMarkdownTheme(file)
      writeMarkdownTheme(theme.id)
      setNotice({ tone: 'success', text: t('markdownThemeImportSuccess', { name: theme.name }) })
    } catch (error) {
      const code = error instanceof MarkdownThemeImportError ? error.code : 'storage'
      setNotice({ tone: 'danger', text: t(`markdownThemeImportErrors.${code}`) })
    } finally {
      setImporting(false)
    }
  }

  const removeTheme = (id: CustomMarkdownThemeId, name: string) => {
    removeCustomMarkdownTheme(id)
    if (currentTheme === id) writeMarkdownTheme(DEFAULT_MARKDOWN_THEME)
    setNotice({ tone: 'success', text: t('markdownThemeRemoveSuccess', { name }) })
  }

  const themeRow = (id: MarkdownThemeId, name: string, description: string, removable = false) => {
    const active = currentTheme === id
    return <article key={id} className="markdown-theme-manager-row">
      <div className="markdown-theme-manager-copy">
        <div className="markdown-theme-manager-name">
          <span>{name}</span>
          {active && <StatusBadge tone="accent" dot>{t('markdownThemeActive')}</StatusBadge>}
        </div>
        <p>{description}</p>
      </div>
      <div className="markdown-theme-manager-actions">
        {!active && <Button size="small" onClick={() => selectTheme(id)}>{t('markdownThemeUse')}</Button>}
        {removable && <Button size="small" variant="danger" onClick={() => removeTheme(id as CustomMarkdownThemeId, name)}>{t('markdownThemeRemove')}</Button>}
      </div>
    </article>
  }

  return <Dialog
    open={open}
    size="large"
    className="markdown-theme-manager"
    title={t('markdownThemeManagerTitle')}
    description={t('markdownThemeManagerDescription')}
    onClose={onClose}
  >
    <section className="markdown-theme-manager-import" aria-labelledby="markdown-theme-import-title">
      <div>
        <h3 id="markdown-theme-import-title">{t('markdownThemeImportTitle')}</h3>
        <p>{t('markdownThemeImportHint')}</p>
      </div>
      <input ref={inputRef} className="markdown-theme-file-input" type="file" accept=".css,text/css" aria-label={t('markdownThemeImport')} onChange={event => void handleImport(event)}/>
      <Button variant="primary" size="small" loading={importing} onClick={() => inputRef.current?.click()}>
        <UiIcon name="upload" size={14}/><span>{t('markdownThemeImport')}</span>
      </Button>
    </section>
    {notice && <div className={`markdown-theme-manager-notice is-${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>{notice.text}</div>}

    <section className="markdown-theme-manager-section" aria-labelledby="markdown-theme-built-in-title">
      <h3 id="markdown-theme-built-in-title">{t('markdownThemeBuiltIn')}</h3>
      <div className="markdown-theme-manager-list">
        {themeRow('next-helvetica', 'Next Helvetica', t('markdownThemeNextDescription'))}
        {themeRow('agent-lens', 'AgentLens', t('markdownThemeAgentLensDescription'))}
      </div>
    </section>

    <section className="markdown-theme-manager-section" aria-labelledby="markdown-theme-custom-title">
      <h3 id="markdown-theme-custom-title">{t('markdownThemeCustom', { count: customThemes.length })}</h3>
      {customThemes.length
        ? <div className="markdown-theme-manager-list">{customThemes.map(theme => themeRow(theme.id, theme.name, theme.sourceName, true))}</div>
        : <div className="markdown-theme-manager-empty">{t('markdownThemeEmpty')}</div>}
    </section>
  </Dialog>
}
