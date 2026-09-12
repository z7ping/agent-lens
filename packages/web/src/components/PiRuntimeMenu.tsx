import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Dialog, IconButton, UiIcon } from './ui'
import './pi-runtime-menu.css'

export function PiRuntimeMenu({
  busy,
  onTerminate,
}: {
  busy: boolean
  onTerminate(): void
}) {
  const { t } = useTranslation('piLive')
  const [confirmOpen, setConfirmOpen] = useState(false)

  return <>
    <IconButton
      variant="danger"
      className="pi-runtime-terminate-button"
      title={t('runtimeMenu.terminateTitle')}
      aria-label={t('runtimeMenu.terminateTitle')}
      disabled={busy}
      onClick={() => setConfirmOpen(true)}
    ><UiIcon name="power" size={16}/></IconButton>

    <Dialog
      open={confirmOpen}
      className="pi-runtime-terminate-dialog"
      title={t('runtimeMenu.dialogTitle')}
      description={t('runtimeMenu.dialogDescription')}
      closeDisabled={busy}
      onClose={() => setConfirmOpen(false)}
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmOpen(false)}>{t('runtimeMenu.cancel')}</Button>
        <Button variant="danger" disabled={busy} onClick={() => {
          setConfirmOpen(false)
          onTerminate()
        }}>{t('runtimeMenu.terminate')}</Button>
      </>}
    >
      <p className="pi-runtime-terminate-copy">{t('runtimeMenu.hint')}</p>
    </Dialog>
  </>
}
