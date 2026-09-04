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
  $getRoot,
  $getSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type EditorState,
} from 'lexical'
import { forwardRef, useEffect, useImperativeHandle, type ForwardedRef } from 'react'

export interface PiMarkdownComposerHandle {
  focus(options?: FocusOptions): void
}

export interface PiMarkdownComposerProps {
  value: string
  onChange(value: string): void
  onSubmit(mode: 'default' | 'followUp'): void
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

function ExternalValuePlugin({ value }: { value: string }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    let current = ''
    editor.getEditorState().read(() => {
      current = $convertToMarkdownString(TRANSFORMERS, undefined, true)
    })
    if (current === value) return
    editor.update(() => {
      $convertFromMarkdownString(value, TRANSFORMERS, undefined, true)
    })
  }, [editor, value])
  return null
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
  useEffect(() => {
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!event || event.shiftKey || event.isComposing || event.keyCode === 229) return false
        event.preventDefault()
        if (canSubmit) onSubmit(event.altKey ? 'followUp' : 'default')
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      event => {
        if (!onEscape || event.isComposing || event.keyCode === 229) return false
        event.preventDefault()
        onEscape()
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    return () => {
      unregisterEnter()
      unregisterEscape()
    }
  }, [canSubmit, editor, onEscape, onSubmit])
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
  }), [editor])
  return null
}

export const PiMarkdownComposer = forwardRef<PiMarkdownComposerHandle, PiMarkdownComposerProps>(function PiMarkdownComposer({
  value,
  onChange,
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
    <div className="pi-markdown-composer">
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
      <OnChangePlugin
        ignoreSelectionChange
        onChange={editorState => {
          const markdown = markdownFromEditor(editorState)
          if (markdown !== value) onChange(markdown)
        }}
      />
      <ExternalValuePlugin value={value}/>
      <EditablePlugin disabled={disabled}/>
      <KeyboardPlugin canSubmit={canSubmit} onSubmit={onSubmit} onEscape={onEscape}/>
      <ComposerRefPlugin forwardedRef={ref}/>
    </div>
  </LexicalComposer>
})
