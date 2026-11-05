import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { Button } from '../components/ui'

/** A rendering budget, not a limit on the source evidence or copyable text.
 * Count UTF-16 code units because String.slice and the DOM use those offsets. */
export const TASK_TEXT_WINDOW_THRESHOLD = 64 * 1024
export const TASK_TEXT_WINDOW_SIZE = 16 * 1024

export function isLargeTaskText(text: string): boolean {
  return text.length > TASK_TEXT_WINDOW_THRESHOLD
}

export interface TaskTextPage {
  start: number
  end: number
  total: number
  text: string
  hasPrevious: boolean
  hasNext: boolean
}

/** A pure bounded page reader. Nothing outside the current window is mounted
 * into the DOM or sent to Markdown/Prism, regardless of how large the source is. */
export function taskTextPage(text: string, requestedPage: number): TaskTextPage {
  const lastPage = Math.max(0, Math.ceil(text.length / TASK_TEXT_WINDOW_SIZE) - 1)
  const page = Number.isSafeInteger(requestedPage)
    ? Math.max(0, Math.min(requestedPage, lastPage)) : 0
  const start = page * TASK_TEXT_WINDOW_SIZE
  const end = Math.min(start + TASK_TEXT_WINDOW_SIZE, text.length)
  return {
    start, end, total: text.length,
    text: text.slice(start, end),
    hasPrevious: page > 0,
    hasNext: end < text.length,
  }
}

/** Shared low-cost viewer for oversized Process text, reasoning, messages
 * and tool output. Reuses the existing CopyableCodeBlock and Button.
 * Copy uses the exact original text, while rendering only a 16 Ki-char page.
 * No second stored body, guessed source cursor, Markdown parse or Prism pass. */
export function TaskTextWindow({ text }: { text: string }) {
  const { t } = useTranslation('task')
  const [pageIndex, setPageIndex] = useState(0)
  const page = taskTextPage(text, pageIndex)

  return <div className="task-text-window" data-text-window="true" data-total-chars={text.length}
    data-window-start={page.start} data-window-end={page.end}>
    <div className="task-text-window-heading">
      {t('largeContent.summary', { count: text.length })}
    </div>
    <CopyableCodeBlock copyValue={text}>{page.text}</CopyableCodeBlock>
    <div className="task-text-window-nav">
      <span className="task-text-window-range">
        {t('largeContent.range', { start: page.start + 1, end: page.end, total: page.total })}
      </span>
      <Button size="small" variant="quiet" disabled={!page.hasPrevious}
        onClick={() => setPageIndex(Math.max(0, Math.floor(page.start / TASK_TEXT_WINDOW_SIZE) - 1))}>
        {t('largeContent.previous')}
      </Button>
      <Button size="small" variant="quiet" disabled={!page.hasNext}
        onClick={() => setPageIndex(Math.floor(page.start / TASK_TEXT_WINDOW_SIZE) + 1)}>
        {t('largeContent.next')}
      </Button>
    </div>
  </div>
}
