import { useRef, useState } from 'react'
import { Button, Dialog, IconButton, Popover, UiIcon } from './ui'
import './pi-runtime-menu.css'

export function PiRuntimeMenu({
  busy,
  onTerminate,
}: {
  busy: boolean
  onTerminate(): void
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const requestTerminate = () => {
    setMenuOpen(false)
    setConfirmOpen(true)
  }

  return <>
    <span ref={anchorRef} className="pi-runtime-menu-anchor">
      <IconButton
        size="small"
        className="pi-live-menu"
        title="更多 Runtime 操作"
        aria-label="更多 Runtime 操作"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => setMenuOpen(value => !value)}
      ><UiIcon name="more" size={14}/></IconButton>
    </span>

    <Popover
      open={menuOpen}
      anchorRef={anchorRef}
      onClose={() => setMenuOpen(false)}
      className="pi-runtime-menu"
    >
      <div className="pi-runtime-menu-list" role="menu" aria-label="Pi Runtime 操作">
        <button
          type="button"
          role="menuitem"
          className="pi-runtime-menu-item is-danger"
          onClick={requestTerminate}
        >结束 Pi Runtime</button>
      </div>
    </Popover>

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
