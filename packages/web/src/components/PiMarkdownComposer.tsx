import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type EditorState,
  type LexicalEditor,
} from 'lexical'
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, type ForwardedRef } from 'react'
import { ComposerDraftPresenceGate } from './pi-markdown-composer-state'

export interface PiMarkdownComposerDraft {
  revision: number
  value: string
}

export interface PiMarkdownComposerHandle {
  focus(options?: FocusOptions): void
  getMarkdown(): string
  isEmpty(): boolean
}

export interface PiMarkdownComposerProps {
  draft: PiMarkdownComposerDraft
  onDraftPresenceChange(hasContent: boolean): void
  onSubmit(value: string, mode: 'default' | 'followUp'): void
  onEscape: (() => void) | undefined
  canSubmit: boolean
  disabled?: boolean
  placeholder: string
  ariaLabel: string
  title?: string
}

const theme = {
  paragraph: 'pi-md-paragraph',
  heading: {
    h1: 'pi-md-h1',
    h2: 'pi-md-h2',
    h3: 'pi-md-h3',
    h4: 'pi-md-h4',
    h5: 'pi-md-h5',
    h6: 'pi-md-h6',
  },
  quote: 'pi-md-quote',
  list: {
    ul: 'pi-md-ul',
    ol: 'pi-md-ol',
    checklist: 'pi-md-checklist',
    listitem: 'pi-md-listitem',
    listitemChecked: 'pi-md-listitem-checked',
    listitemUnchecked: 'pi-md-listitem-unchecked',
    nested: { listitem: 'pi-md-listitem-nested' },
  },
  code: 'pi-md-code-block',
  link: 'pi-md-link',
  text: {
    bold: 'pi-md-bold',
    italic: 'pi-md-italic',
    code: 'pi-md-inline-code',
    strikethrough: 'pi-md-strikethrough',
  },
}

function markdownFromEditor(editorState: EditorState): string {
  let markdown = ''
  editorState.read(() => {
    markdown = $convertToMarkdownString(TRANSFORMERS, undefined, true)
  })
  return markdown
}

function editorHasContent(editorState: EditorState): boolean {
  let hasContent = false
  editorState.read(() => {
    hasContent = Boolean($getRoot().getTextContent().trim())
  })
  return hasContent
}

function replaceMarkdownDocument(editor: LexicalEditor, value: string): void {
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    if (value) {
      $convertFromMarkdownString(value, TRANSFORMERS, root, true)
      root.selectEnd()
      return
    }
    const paragraph = $createParagraphNode()
    root.append(paragraph)
    paragraph.selectStart()
  })
}

/**
 * Only explicit parent commands carry a new revision. Local editing never
 * changes this prop, so there is no controlled-value echo back into Lexical.
 */
function ExternalDraftPlugin({ draft }: { draft: PiMarkdownComposerDraft }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      if (cancelled) return
      if (editor.isComposing()) {
        timer = setTimeout(apply, 16)
        return
      }
      replaceMarkdownDocument(editor, draft.value)
    }
    apply()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [draft.revision, draft.value, editor])
  return null
}

function DraftPresencePlugin({ onChange }: { onChange(hasContent: boolean): void }) {
  const gate = useRef(new ComposerDraftPresenceGate())
  return <OnChangePlugin
    ignoreSelectionChange
    onChange={editorState => {
      const hasContent = editorHasContent(editorState)
      if (!gate.current.accept(hasContent)) return
      onChange(hasContent)
    }}
  />
}

function EditablePlugin({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    editor.setEditable(!disabled)
  }, [disabled, editor])
  return null
}

function KeyboardPlugin({
  canSubmit,
  onSubmit,
  onEscape,
}: Pick<PiMarkdownComposerProps, 'canSubmit' | 'onSubmit' | 'onEscape'>) {
  const [editor] = useLexicalComposerContext()
  const canSubmitRef = useRef(canSubmit)
  const submitRef = useRef(onSubmit)
  const escapeRef = useRef(onEscape)

  useEffect(() => {
    canSubmitRef.current = canSubmit
    submitRef.current = onSubmit
    escapeRef.current = onEscape
  }, [canSubmit, onEscape, onSubmit])

  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!event || event.shiftKey || event.isComposing || event.keyCode === 229) return false
        event.preventDefault()
        if (canSubmitRef.current) {
          const value = markdownFromEditor(editor.getEditorState()).trim()
          if (value) submitRef.current(value, event.altKey ? 'followUp' : 'default')
        }
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      event => {
        const onEscapeCurrent = escapeRef.current
        if (!onEscapeCurrent || event.isComposing || event.keyCode === 229) return false
        event.preventDefault()
        onEscapeCurrent()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    return () => {
      unregisterEnter()
      unregisterEscape()
    }
  }, [editor])
  return null
}

function ComposerRefPlugin({ forwardedRef }: { forwardedRef: ForwardedRef<PiMarkdownComposerHandle> }) {
  const [editor] = useLexicalComposerContext()
  useImperativeHandle(forwardedRef, () => ({
    focus(options?: FocusOptions) {
      const rootElement = editor.getRootElement()
      editor.update(() => {
        if ($getSelection() === null) $getRoot().selectEnd()
      })
      if (rootElement) rootElement.focus(options)
      else editor.focus()
    },
    getMarkdown() {
      return markdownFromEditor(editor.getEditorState())
    },
    isEmpty() {
      return !editorHasContent(editor.getEditorState())
    },
  }), [editor])
  return null
}

const PiMarkdownComposerImpl = forwardRef<PiMarkdownComposerHandle, PiMarkdownComposerProps>(function PiMarkdownComposer({
  draft,
  onDraftPresenceChange,
  onSubmit,
  onEscape,
  canSubmit,
  disabled = false,
  placeholder,
  ariaLabel,
  title,
}, ref) {
  return <LexicalComposer initialConfig={{
    namespace: 'AgentLensPiMarkdownComposer',
    theme,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
    onError(error) { throw error },
  }}>
    <div
      className="pi-markdown-composer"
      onMouseDown={event => {
        const target = event.target as HTMLElement
        if (target.closest('[contenteditable="true"]')) return
        event.currentTarget.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true })
      }}
    >
      <RichTextPlugin
        contentEditable={<ContentEditable
          className="pi-live-input pi-markdown-input"
          aria-label={ariaLabel}
          title={title}
          spellCheck
        />}
        placeholder={<div className="pi-markdown-placeholder">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin/>
      <MarkdownShortcutPlugin transformers={TRANSFORMERS}/>
      <DraftPresencePlugin onChange={onDraftPresenceChange}/>
      <ExternalDraftPlugin draft={draft}/>
      <EditablePlugin disabled={disabled}/>
      <KeyboardPlugin canSubmit={canSubmit} onSubmit={onSubmit} onEscape={onEscape}/>
      <ComposerRefPlugin forwardedRef={ref}/>
    </div>
  </LexicalComposer>
})

export const PiMarkdownComposer = memo(PiMarkdownComposerImpl)
PiMarkdownComposer.displayName = 'PiMarkdownComposer'
