import type { LiveMessageDto } from '@agent-lens/protocol'
import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
  type ElementTransformer,
  type Transformer,
} from '@lexical/markdown'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, type ForwardedRef } from 'react'
import { removeLiveAttachment, uploadLiveAttachment } from '../client/live-attachments'
import { ComposerDraftPresenceGate } from './live-markdown-composer-state'
import {
  $createLiveImageNode,
  $isLiveImageNode,
  LiveImageNode,
} from './LiveImageNode'
import {
  $createLiveLargeTextNode,
  $isLiveLargeTextNode,
  LiveLargeTextNode,
} from './LiveLargeTextNode'

const LARGE_TEXT_LINE_THRESHOLD = 10
const LARGE_TEXT_CHAR_THRESHOLD = 1000
const LIVE_PART_MARKER_PREFIX = '\uE000agentlens-live-'
const LIVE_PART_MARKER_SUFFIX = '\uE001'
const LIVE_PART_MARKER_PATTERN = /\uE000agentlens-live-(large-text|image):([^\uE001]+)\uE001/g

export interface LiveMarkdownComposerDraft {
  revision: number
  value: string
}

export interface LiveMarkdownComposerHandle {
  focus(options?: FocusOptions): void
  getMarkdown(): string
  getMessage(): LiveMessageDto
  isEmpty(): boolean
}

export interface LiveMarkdownComposerProps {
  draft: LiveMarkdownComposerDraft
  onDraftPresenceChange(hasContent: boolean): void
  onSubmit(message: LiveMessageDto, mode: 'default' | 'followUp'): void
  onEscape: (() => void) | undefined
  canSubmit: boolean
  disabled?: boolean
  placeholder: string
  ariaLabel: string
  title?: string
  inputClassName?: string
  onAttachmentPendingChange?: ((pending: boolean) => void) | undefined
  onAttachmentError?: ((error: unknown) => void) | undefined
}

const theme = {
  paragraph: 'live-md-paragraph',
  heading: {
    h1: 'live-md-h1',
    h2: 'live-md-h2',
    h3: 'live-md-h3',
    h4: 'live-md-h4',
    h5: 'live-md-h5',
    h6: 'live-md-h6',
  },
  quote: 'live-md-quote',
  list: {
    ul: 'live-md-ul',
    ol: 'live-md-ol',
    checklist: 'live-md-checklist',
    listitem: 'live-md-listitem',
    listitemChecked: 'live-md-listitem-checked',
    listitemUnchecked: 'live-md-listitem-unchecked',
    nested: { listitem: 'live-md-listitem-nested' },
  },
  code: 'live-md-code-block',
  link: 'live-md-link',
  text: {
    bold: 'live-md-bold',
    italic: 'live-md-italic',
    code: 'live-md-inline-code',
    strikethrough: 'live-md-strikethrough',
  },
}

const LARGE_TEXT_MARKER_TRANSFORMER: ElementTransformer = {
  dependencies: [LiveLargeTextNode],
  export: (node: LexicalNode) => $isLiveLargeTextNode(node)
    ? `${LIVE_PART_MARKER_PREFIX}large-text:${node.getKey()}${LIVE_PART_MARKER_SUFFIX}`
    : null,
  regExp: /^(?!)$/,
  replace: () => {},
  type: 'element',
}

const IMAGE_MARKER_TRANSFORMER: ElementTransformer = {
  dependencies: [LiveImageNode],
  export: (node: LexicalNode) => $isLiveImageNode(node) && node.getAttachmentId()
    ? `${LIVE_PART_MARKER_PREFIX}image:${node.getKey()}${LIVE_PART_MARKER_SUFFIX}`
    : null,
  regExp: /^(?!)$/,
  replace: () => {},
  type: 'element',
}

const MESSAGE_TRANSFORMERS: Transformer[] = [
  LARGE_TEXT_MARKER_TRANSFORMER,
  IMAGE_MARKER_TRANSFORMER,
  ...TRANSFORMERS,
]

export function isLargeLivePaste(text: string): boolean {
  if (!text) return false
  const lineCount = text.split(/\r\n|\r|\n/).length
  return lineCount > LARGE_TEXT_LINE_THRESHOLD || text.length > LARGE_TEXT_CHAR_THRESHOLD
}

function markdownFromEditor(editorState: EditorState): string {
  let markdown = ''
  editorState.read(() => {
    markdown = $convertToMarkdownString(TRANSFORMERS, undefined, true)
  })
  return markdown
}

function collectStructuredNodes(
  node: LexicalNode,
  largeText: Map<string, string>,
  images: Map<string, NonNullable<ReturnType<LiveImageNode['getImagePart']>>>,
): void {
  if ($isLiveLargeTextNode(node)) {
    largeText.set(node.getKey(), node.getText())
    return
  }
  if ($isLiveImageNode(node)) {
    const part = node.getImagePart()
    if (part) images.set(node.getKey(), part)
    return
  }
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) collectStructuredNodes(child, largeText, images)
  }
}

function messageFromEditor(editorState: EditorState): LiveMessageDto {
  let message: LiveMessageDto = { parts: [] }

  editorState.read(() => {
    const largeTextByKey = new Map<string, string>()
    const imagesByKey = new Map<string, NonNullable<ReturnType<LiveImageNode['getImagePart']>>>()
    const root = $getRoot()
    for (const child of root.getChildren()) collectStructuredNodes(child, largeTextByKey, imagesByKey)

    const markdown = $convertToMarkdownString(MESSAGE_TRANSFORMERS, undefined, true)
    const parts: LiveMessageDto['parts'] = []
    let cursor = 0
    LIVE_PART_MARKER_PATTERN.lastIndex = 0

    const appendText = (value: string) => {
      if (!value) return
      const previous = parts.at(-1)
      if (previous?.type === 'text') previous.text += value
      else parts.push({ type: 'text', text: value })
    }

    let match: RegExpExecArray | null
    while ((match = LIVE_PART_MARKER_PATTERN.exec(markdown)) !== null) {
      let before = markdown.slice(cursor, match.index)
      if (before.endsWith('\n')) before = before.slice(0, -1)
      appendText(before)

      const type = match[1]
      const key = match[2] ?? ''
      if (type === 'large-text') {
        const text = largeTextByKey.get(key)
        if (text !== undefined) {
          parts.push({
            type: 'large-text',
            text,
            lineCount: text.split(/\r\n|\r|\n/).length,
            charCount: text.length,
          })
        }
      } else if (type === 'image') {
        const image = imagesByKey.get(key)
        if (image) parts.push(image)
      }

      cursor = match.index + match[0].length
      if (markdown[cursor] === '\n') cursor += 1
    }

    appendText(markdown.slice(cursor))
    message = { parts }
  })

  return message
}

function editorHasContent(editorState: EditorState): boolean {
  let hasContent = false
  editorState.read(() => {
    hasContent = Boolean($getRoot().getTextContent().trim())
  })
  return hasContent
}

function messageHasContent(message: LiveMessageDto): boolean {
  return message.parts.some(part => {
    if (part.type === 'text' || part.type === 'large-text') return Boolean(part.text.trim())
    return true
  })
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

function ExternalDraftPlugin({ draft }: { draft: LiveMarkdownComposerDraft }) {
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

function LargePastePlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => editor.registerCommand(
    PASTE_COMMAND,
    event => {
      if (!('clipboardData' in event) || !event.clipboardData) return false
      if (event.clipboardData.files.length > 0) return false
      const text = event.clipboardData.getData('text/plain')
      if (!isLargeLivePaste(text)) return false

      event.preventDefault()
      const node = $createLiveLargeTextNode(text)
      $insertNodes([node])
      const parent = node.getParent()
      if ($isRootOrShadowRoot(parent) && node.getNextSibling() === null) {
        const paragraph = $createParagraphNode()
        node.insertAfter(paragraph)
        paragraph.selectStart()
      } else {
        node.selectNext()
      }
      return true
    },
    COMMAND_PRIORITY_HIGH,
  ), [editor])
  return null
}

function ImagePastePlugin({
  onPendingChange,
  onError,
}: {
  onPendingChange?: ((pending: boolean) => void) | undefined
  onError?: ((error: unknown) => void) | undefined
}) {
  const [editor] = useLexicalComposerContext()
  const pendingCountRef = useRef(0)
  useEffect(() => editor.registerCommand(
    PASTE_COMMAND,
    event => {
      if (!('clipboardData' in event) || !event.clipboardData) return false
      const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
      if (!files.length) return false

      event.preventDefault()
      const pending = files.map(file => {
        const previewUrl = URL.createObjectURL(file)
        const node = $createLiveImageNode({
          name: file.name || undefined,
          mimeType: file.type || undefined,
          sizeBytes: file.size,
          previewUrl,
        })
        return { file, node, nodeKey: node.getKey(), previewUrl }
      })
      const nodes = pending.map(item => item.node)
      $insertNodes(nodes)
      const last = nodes.at(-1)
      const parent = last?.getParent()
      if (last && $isRootOrShadowRoot(parent) && last.getNextSibling() === null) {
        const paragraph = $createParagraphNode()
        last.insertAfter(paragraph)
        paragraph.selectStart()
      } else {
        last?.selectNext()
      }

      const wasIdle = pendingCountRef.current === 0
      pendingCountRef.current += pending.length
      if (wasIdle) onPendingChange?.(true)
      void Promise.allSettled(pending.map(async item => {
        try {
          const descriptor = await uploadLiveAttachment(item.file)
          let attached = false
          editor.update(() => {
            const current = $getNodeByKey(item.nodeKey)
            if (!$isLiveImageNode(current)) return
            current.setAttachment(descriptor)
            attached = true
          })
          if (!attached) await removeLiveAttachment(descriptor.attachmentId).catch(() => undefined)
        } catch (error) {
          editor.update(() => {
            const current = $getNodeByKey(item.nodeKey)
            if ($isLiveImageNode(current)) current.remove()
          })
          onError?.(error)
        } finally {
          URL.revokeObjectURL(item.previewUrl)
        }
      })).then(() => {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - pending.length)
        if (pendingCountRef.current === 0) onPendingChange?.(false)
      })
      return true
    },
    COMMAND_PRIORITY_HIGH,
  ), [editor, onError, onPendingChange])
  return null
}


function KeyboardPlugin({
  canSubmit,
  onSubmit,
  onEscape,
}: Pick<LiveMarkdownComposerProps, 'canSubmit' | 'onSubmit' | 'onEscape'>) {
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
        if (!event || event.isComposing || event.keyCode === 229) return false
        if (event.shiftKey) {
          event.preventDefault()
          editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined)
          return true
        }
        event.preventDefault()
        if (canSubmitRef.current) {
          const message = messageFromEditor(editor.getEditorState())
          if (messageHasContent(message)) submitRef.current(message, event.altKey ? 'followUp' : 'default')
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

function ComposerRefPlugin({ forwardedRef }: { forwardedRef: ForwardedRef<LiveMarkdownComposerHandle> }) {
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
    getMessage() {
      return messageFromEditor(editor.getEditorState())
    },
    isEmpty() {
      return !editorHasContent(editor.getEditorState())
    },
  }), [editor])
  return null
}

const LiveMarkdownComposerImpl = forwardRef<LiveMarkdownComposerHandle, LiveMarkdownComposerProps>(function LiveMarkdownComposer({
  draft,
  onDraftPresenceChange,
  onSubmit,
  onEscape,
  canSubmit,
  disabled = false,
  placeholder,
  ariaLabel,
  title,
  inputClassName,
  onAttachmentPendingChange,
  onAttachmentError,
}, ref) {
  return <LexicalComposer initialConfig={{
    namespace: 'AgentLensLiveMarkdownComposer',
    theme,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, LiveLargeTextNode, LiveImageNode],
    onError(error) { throw error },
  }}>
    <div
      className="live-markdown-composer"
      onMouseDown={event => {
        const target = event.target as HTMLElement
        if (target.closest('[contenteditable="true"]') || target.closest('button')) return
        event.currentTarget.querySelector<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true })
      }}
    >
      <RichTextPlugin
        contentEditable={<ContentEditable
          className={['live-markdown-input', inputClassName].filter(Boolean).join(' ')}
          aria-label={ariaLabel}
          title={title}
          spellCheck
        />}
        placeholder={<div className="live-markdown-placeholder">{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin/>
      <ListPlugin/>
      <MarkdownShortcutPlugin transformers={TRANSFORMERS}/>
      <LargePastePlugin/>
      <ImagePastePlugin onPendingChange={onAttachmentPendingChange} onError={onAttachmentError}/>
      <DraftPresencePlugin onChange={onDraftPresenceChange}/>
      <ExternalDraftPlugin draft={draft}/>
      <EditablePlugin disabled={disabled}/>
      <KeyboardPlugin canSubmit={canSubmit} onSubmit={onSubmit} onEscape={onEscape}/>
      <ComposerRefPlugin forwardedRef={ref}/>
    </div>
  </LexicalComposer>
})

export const LiveMarkdownComposer = memo(LiveMarkdownComposerImpl)
LiveMarkdownComposer.displayName = 'LiveMarkdownComposer'
