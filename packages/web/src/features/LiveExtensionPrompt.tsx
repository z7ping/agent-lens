import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveEventDto } from '@agent-lens/protocol'
import { Button, Dialog, Input, Textarea } from '../components/ui'

type LiveUiRequest = Extract<LiveEventDto, { type: 'ui.request' }>

/** 所有 Agent 的 Runtime UI 请求共用一套可访问的确认、选择和输入弹窗。 */
export function LiveExtensionPrompt({
  request,
  pending,
  onAnswer,
}: {
  request: LiveUiRequest
  pending: boolean
  onAnswer(value: unknown): void
}) {
  const { t } = useTranslation('task')
  const [value, setValue] = useState(request.prefill ?? '')
  useEffect(() => setValue(request.prefill ?? ''), [request.requestId, request.prefill])

  const title = request.title || t('live.extension.title')
  const dismiss = () => {
    if (pending) return
    onAnswer(request.method === 'confirm' ? { confirmed: false } : { cancelled: true })
  }
  const footer = request.method === 'confirm'
    ? <>
        <Button size="small" disabled={pending} onClick={dismiss}>{t('live.extension.reject')}</Button>
        <Button size="small" variant="primary" loading={pending} onClick={() => onAnswer({ confirmed: true })}>{t('live.extension.allow')}</Button>
      </>
    : request.method === 'select'
      ? <Button size="small" disabled={pending} onClick={dismiss}>{t('live.extension.cancel')}</Button>
      : <>
          <Button size="small" disabled={pending} onClick={dismiss}>{t('live.extension.cancel')}</Button>
          <Button size="small" variant="primary" loading={pending} onClick={() => onAnswer({ value })}>{t('live.extension.submit')}</Button>
        </>

  return <Dialog
    open
    title={title}
    description={request.message || undefined}
    closeOnBackdrop={false}
    closeDisabled={pending}
    onClose={dismiss}
    footer={footer}
  >
    {request.method === 'select'
      ? <div className="live-extension-options" role="group" aria-label={title}>
          {(request.options ?? []).map(option =>
            <Button size="small" disabled={pending} key={option} onClick={() => onAnswer({ value: option })}>{option}</Button>)}
        </div>
      : request.method === 'editor'
        ? <Textarea className="live-extension-input" aria-label={title} value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>
        : request.method === 'confirm'
          ? null
          : <Input className="live-extension-input" aria-label={title} value={value} onChange={event => setValue(event.target.value)} placeholder={request.placeholder}/>}
  </Dialog>
}
