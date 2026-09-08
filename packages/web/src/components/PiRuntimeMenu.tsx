import { useState } from 'react'
import { Button, Dialog, IconButton, UiIcon } from './ui'
import './pi-runtime-menu.css'

export function PiRuntimeMenu({
  busy,
  onTerminate,
}: {
  busy: boolean
  onTerminate(): void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return <>
    <IconButton
      size="small"
      variant="danger"
      className="pi-runtime-terminate-button"
      title="结束 Pi Runtime"
      aria-label="结束 Pi Runtime"
      disabled={busy}
      onClick={() => setConfirmOpen(true)}
    ><UiIcon name="power" size={14}/></IconButton>

    <Dialog
      open={confirmOpen}
      className="pi-runtime-terminate-dialog"
      title="结束 Pi Runtime？"
      description="这会终止当前后台 Pi Runtime；当前任务会停止，但已经写入的会话历史不会删除。"
      closeDisabled={busy}
      onClose={() => setConfirmOpen(false)}
      footer={<>
        <Button disabled={busy} onClick={() => setConfirmOpen(false)}>取消</Button>
        <Button variant="danger" disabled={busy} onClick={() => {
          setConfirmOpen(false)
          onTerminate()
        }}>结束 Runtime</Button>
      </>}
    >
      <p className="pi-runtime-terminate-copy">如果只是想中断当前一轮生成，请使用“停止当前任务”，不需要结束整个 Runtime。</p>
    </Dialog>
  </>
}
