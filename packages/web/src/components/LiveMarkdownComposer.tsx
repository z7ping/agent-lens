import type { LiveCommandDto, LiveMessageDto, LiveWorkspaceFileReferenceDto } from '@agent-lens/protocol'
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
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
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
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  PASTE_COMMAND,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical'
import {
  forwardRef,
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
} from 'react'
import { removeLiveAttachment, uploadLiveAttachment } from '../client/live-attachments'
import { ComposerDraftPresenceGate } from './live-markdown-composer-state'
import {
  ComposerInputHistoryNavigator,
  writeLiveComposerDraft,
} from './live-composer-session-state'
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
  clear(): void
  restoreMessage(message: LiveMessageDto): void
}

export interface LiveMarkdownComposerProps {
  draft: LiveMarkdownComposerDraft
  onDraftPresenceChange(hasContent: boolean): void
  /** Session-scoped browser draft key. Persistence stays inside the Composer. */
  draftKey?: string | undefined
  /** Oldest -> newest submitted textual inputs for ArrowUp/ArrowDown recall. */
  inputHistory?: readonly string[] | undefined
  /** Runtime-owned commands. Composer only filters and inserts the opaque value. */
  commands?: readonly LiveCommandDto[] | undefined
  /** Runtime-bound workspace file lookup. Composer only inserts the Runtime-owned value. */
  workspaceReferenceSearch?: ((query: string) => Promise<readonly LiveWorkspaceFileReferenceDto[]>) | undefined
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

function draftTextFromEditor(editorState: EditorState): string {
  return messageFromEditor(editorState).parts
    .flatMap(part => part.type === 'text' || part.type === 'large-text' ? [part.text] : [])
    .join('\n\n')
}

function commandQueryFromEditor(editorState: EditorState): string | null {
  let query: string | null = null
  editorState.read(() => {
    const text = $getRoot().getTextContent()
    if (!text.startsWith('/') || /[\r\n\t ]/.test(text)) return
    query = text.slice(1)
  })
  return query
}

function replacePlainTextDocument(editor: LexicalEditor, value: string): void {
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    const paragraph = $createParagraphNode()
    if (value) paragraph.append($createTextNode(value))
    root.append(paragraph)
    paragraph.selectEnd()
  })
}

interface WorkspaceReferenceQuery {
  query: string
  nodeKey: string
  startOffset: number
  endOffset: number
}

function workspaceReferenceQueryFromEditor(editorState: EditorState): WorkspaceReferenceQuery | null {
  let result: WorkspaceReferenceQuery | null = null
  editorState.read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
    const node = selection.anchor.getNode()
    if (!$isTextNode(node)) return
    const endOffset = selection.anchor.offset
    const before = node.getTextContent().slice(0, endOffset)
    const match = before.match(/(^|\s)@(?:"([^"\r\n]*)|([^\s@"\r\n]*))$/)
    if (!match) return
    const prefix = match[1] ?? ''
    const tokenLength = match[0].length - prefix.length
    result = {
      query: match[2] ?? match[3] ?? '',
      nodeKey: node.getKey(),
      startOffset: endOffset - tokenLength,
      endOffset,
    }
  })
  return result
}

function insertWorkspaceReference(
  editor: LexicalEditor,
  query: WorkspaceReferenceQuery,
  reference: LiveWorkspaceFileReferenceDto,
): void {
  editor.update(() => {
    const node = $getNodeByKey(query.nodeKey)
    if (!$isTextNode(node)) return
    const text = node.getTextContent()
    if (query.startOffset < 0 || query.endOffset > text.length || query.startOffset > query.endOffset) return
    const current = text.slice(query.startOffset, query.endOffset)
    if (!current.startsWith('@')) return
    node.spliceText(
      query.startOffset,
      query.endOffset - query.startOffset,
      `${reference.value} `,
      true,
    )
  })
}

function historyTextFromEditor(editorState: EditorState): string | null {
  const message = messageFromEditor(editorState)
  if (message.parts.some(part => part.type !== 'text' && part.type !== 'large-text')) return null
  return message.parts
    .flatMap(part => part.type === 'text' || part.type === 'large-text' ? [part.text] : [])
    .join('\n\n')
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

function plainTextParagraphs(value: string): LexicalNode[] {
  const blocks = value.split(/\n\n/)
  return blocks.map(block => {
    const paragraph = $createParagraphNode()
    const lines = block.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append($createLineBreakNode())
      if (line) paragraph.append($createTextNode(line))
    })
    return paragraph
  })
}

function restoredMessageNodes(message: LiveMessageDto): LexicalNode[] {
  const nodes: LexicalNode[] = []
  for (const part of message.parts) {
    if (part.type === 'text') {
      nodes.push(...plainTextParagraphs(part.text))
    } else if (part.type === 'large-text') {
      nodes.push($createLiveLargeTextNode(part.text))
    } else if (part.type === 'image') {
      nodes.push($createLiveImageNode({
        attachmentId: part.attachmentId,
        ...(part.name ? { name: part.name } : {}),
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        ...(part.sizeBytes !== undefined ? { sizeBytes: part.sizeBytes } : {}),
      }))
    }
  }
  return nodes
}

function restoreMessageBeforeCurrentDraft(editor: LexicalEditor, message: LiveMessageDto): void {
  editor.update(() => {
    const root = $getRoot()
    const restored = restoredMessageNodes(message)
    if (!restored.length) return

    const currentHasContent = Boolean(root.getTextContent().trim())
    if (!currentHasContent) {
      root.clear()
      root.append(...restored)
      const tail = $createParagraphNode()
      root.append(tail)
      tail.selectEnd()
      return
    }

    const first = root.getFirstChild()
    if (!first) {
      root.append(...restored)
      root.selectEnd()
      return
    }
    for (const node of restored) first.insertBefore(node)
    first.insertBefore($createParagraphNode())
    root.selectEnd()
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

function DraftPersistencePlugin({ draftKey }: { draftKey?: string | undefined }) {
  const pendingRef = useRef<{ key: string; state: EditorState } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) writeLiveComposerDraft(pending.key, draftTextFromEditor(pending.state))
  }

  useEffect(() => flush, [draftKey])

  if (!draftKey) return null
  return <OnChangePlugin
    ignoreSelectionChange
    onChange={editorState => {
      pendingRef.current = { key: draftKey, state: editorState }
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flush, 180)
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
        const attachmentId = globalThis.crypto.randomUUID()
        const previewUrl = URL.createObjectURL(file)
        const node = $createLiveImageNode({
          attachmentId,
          name: file.name || undefined,
          mimeType: file.type || undefined,
          sizeBytes: file.size,
          previewUrl,
        })
        return { attachmentId, file, node, nodeKey: node.getKey() }
      })
      const nodes = pending.map(item => item.node)
      $insertNodes(nodes)
      const last = nodes.at(-1)
      const parent = last?.getParent() ?? null
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
          const descriptor = await uploadLiveAttachment(item.file, item.attachmentId)
          if (descriptor.attachmentId !== item.attachmentId) {
            await removeLiveAttachment(descriptor.attachmentId).catch(() => undefined)
            throw new Error('Live attachment ID changed during upload')
          }
          let nodeStillPresent = false
          editor.getEditorState().read(() => {
            nodeStillPresent = $isLiveImageNode($getNodeByKey(item.nodeKey))
          })
          if (!nodeStillPresent) {
            await removeLiveAttachment(item.attachmentId).catch(() => undefined)
          }
        } catch (error) {
          editor.update(() => {
            const current = $getNodeByKey(item.nodeKey)
            if ($isLiveImageNode(current)) current.remove()
          })
          onError?.(error)
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


function WorkspaceReferenceMenuPlugin({
  search,
}: {
  search?: ((query: string) => Promise<readonly LiveWorkspaceFileReferenceDto[]>) | undefined
}) {
  const { t } = useTranslation('task')
  const [editor] = useLexicalComposerContext()
  const menuId = useId()
  const [query, setQuery] = useState<WorkspaceReferenceQuery | null>(null)
  const [matches, setMatches] = useState<readonly LiveWorkspaceFileReferenceDto[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    const next = workspaceReferenceQueryFromEditor(editorState)
    setQuery(previous => {
      if (!next && !previous) return previous
      if (!next || !previous) return next
      return next.query === previous.query
        && next.nodeKey === previous.nodeKey
        && next.startOffset === previous.startOffset
        && next.endOffset === previous.endOffset
        ? previous
        : next
    })
  }), [editor])

  useEffect(() => {
    setActiveIndex(0)
    if (!search || !query) {
      setMatches([])
      return
    }
    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      void search(query.query).then(
        items => {
          if (requestId === requestIdRef.current) setMatches(items.slice(0, 20))
        },
        () => {
          if (requestId === requestIdRef.current) setMatches([])
        },
      )
    }, 90)
    return () => window.clearTimeout(timer)
  }, [query?.query, query?.nodeKey, query?.startOffset, query?.endOffset, search])

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(0, matches.length - 1)))
  }, [matches.length])

  useEffect(() => {
    if (!query || !matches.length) {
      setPosition(null)
      return
    }
    const update = () => {
      const root = editor.getRootElement()
      if (!root) return
      const rect = root.getBoundingClientRect()
      const width = Math.min(Math.max(300, rect.width), Math.max(176, window.innerWidth - 16))
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
      setPosition({
        position: 'fixed',
        left,
        bottom: window.innerHeight - rect.top + 8,
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [editor, matches.length, query])

  useEffect(() => {
    if (!query || !matches.length) return
    const eventAllowed = (event: KeyboardEvent) => !event.isComposing && event.keyCode !== 229
    const choose = (index: number) => {
      const reference = matches[index]
      if (!reference) return
      insertWorkspaceReference(editor, query, reference)
      setQuery(null)
      setMatches([])
      requestAnimationFrame(() => editor.getRootElement()?.focus({ preventScroll: true }))
    }
    const move = (delta: 1 | -1) => {
      setActiveIndex(index => (index + delta + matches.length) % matches.length)
    }

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        move(-1)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        move(1)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!event || !eventAllowed(event)) return false
        event.preventDefault()
        choose(activeIndex)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        setQuery(null)
        setMatches([])
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    return () => {
      unregisterUp()
      unregisterDown()
      unregisterEnter()
      unregisterEscape()
    }
  }, [activeIndex, editor, matches, query])

  if (!query || !matches.length || !position) return null

  return createPortal(
    <div
      className="select-menu-popover live-workspace-reference-menu"
      style={position}
      role="listbox"
      id={menuId}
      aria-label={t('live.workspaceReferenceMenu.aria')}
      onPointerDown={event => event.preventDefault()}
    >
      <div className="select-menu-options live-workspace-reference-menu-options">
        {matches.map((reference, index) => <button
          key={reference.path}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`select-menu-option ${index === activeIndex ? 'is-active' : ''}`.trim()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => {
            insertWorkspaceReference(editor, query, reference)
            setQuery(null)
            setMatches([])
            requestAnimationFrame(() => editor.getRootElement()?.focus({ preventScroll: true }))
          }}
        >
          <span>
            <b>{reference.path}</b>
            <small>{reference.value}</small>
          </span>
        </button>)}
      </div>
    </div>,
    document.body,
  )
}

function CommandMenuPlugin({ commands = [] }: { commands?: readonly LiveCommandDto[] | undefined }) {
  const { t } = useTranslation('task')
  const [editor] = useLexicalComposerContext()
  const menuId = useId()
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<CSSProperties | null>(null)

  const matches = useMemo(() => {
    if (query === null) return []
    const needle = query.toLocaleLowerCase()
    return commands
      .filter(command => {
        if (!needle) return true
        return [command.value, command.label, command.description, command.group]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .some(value => value.toLocaleLowerCase().includes(needle))
      })
      .slice(0, 12)
  }, [commands, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    setActiveIndex(index => Math.min(index, Math.max(0, matches.length - 1)))
  }, [matches.length])

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    const next = commandQueryFromEditor(editorState)
    setQuery(previous => previous === next ? previous : next)
  }), [editor])

  useEffect(() => {
    if (query === null || !matches.length) {
      setPosition(null)
      return
    }
    const update = () => {
      const root = editor.getRootElement()
      if (!root) return
      const rect = root.getBoundingClientRect()
      const width = Math.min(Math.max(280, rect.width), Math.max(176, window.innerWidth - 16))
      const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
      setPosition({
        position: 'fixed',
        left,
        bottom: window.innerHeight - rect.top + 8,
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [editor, matches.length, query])

  useEffect(() => {
    if (query === null || !matches.length) return

    const choose = (index: number) => {
      const command = matches[index]
      if (!command) return
      replacePlainTextDocument(editor, `${command.value} `)
      setQuery(null)
      requestAnimationFrame(() => editor.getRootElement()?.focus({ preventScroll: true }))
    }
    const move = (delta: 1 | -1) => {
      setActiveIndex(index => (index + delta + matches.length) % matches.length)
    }
    const eventAllowed = (event: KeyboardEvent) => !event.isComposing && event.keyCode !== 229

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        move(-1)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        move(1)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      event => {
        if (!event || !eventAllowed(event)) return false
        event.preventDefault()
        choose(activeIndex)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      event => {
        if (!eventAllowed(event)) return false
        event.preventDefault()
        setQuery(null)
        return true
      },
      COMMAND_PRIORITY_CRITICAL,
    )
    return () => {
      unregisterUp()
      unregisterDown()
      unregisterEnter()
      unregisterEscape()
    }
  }, [activeIndex, editor, matches, query])

  if (query === null || !matches.length || !position) return null

  return createPortal(
    <div
      className="select-menu-popover live-command-menu"
      style={position}
      role="listbox"
      id={menuId}
      aria-label={t('live.commandMenu.aria')}
      onPointerDown={event => event.preventDefault()}
    >
      <div className="select-menu-options live-command-menu-options">
        {matches.map((command, index) => <button
          key={`${command.group ?? ''}:${command.value}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`select-menu-option ${index === activeIndex ? 'is-active' : ''}`.trim()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => {
            replacePlainTextDocument(editor, `${command.value} `)
            setQuery(null)
            requestAnimationFrame(() => editor.getRootElement()?.focus({ preventScroll: true }))
          }}
        >
          <span>
            <b>{command.label ?? command.value}</b>
            {command.description && <small>{command.description}</small>}
          </span>
        </button>)}
      </div>
    </div>,
    document.body,
  )
}

function KeyboardPlugin({
  canSubmit,
  onSubmit,
  onEscape,
  inputHistory = [],
}: Pick<LiveMarkdownComposerProps, 'canSubmit' | 'onSubmit' | 'onEscape' | 'inputHistory'>) {
  const [editor] = useLexicalComposerContext()
  const canSubmitRef = useRef(canSubmit)
  const submitRef = useRef(onSubmit)
  const escapeRef = useRef(onEscape)
  const inputHistoryRef = useRef<readonly string[]>(inputHistory)
  const historyNavigatorRef = useRef(new ComposerInputHistoryNavigator())
  const appliedHistoryRef = useRef<string | null>(null)

  useEffect(() => {
    canSubmitRef.current = canSubmit
    submitRef.current = onSubmit
    escapeRef.current = onEscape
    inputHistoryRef.current = inputHistory
  }, [canSubmit, inputHistory, onEscape, onSubmit])

  useEffect(() => {
    const applyHistory = (value: string) => {
      appliedHistoryRef.current = value
      replaceMarkdownDocument(editor, value)
    }
    const historyEventAllowed = (event: KeyboardEvent) => (
      !event.isComposing
      && event.keyCode !== 229
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
    )

    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      event => {
        if (!historyEventAllowed(event)) return false
        const current = historyTextFromEditor(editor.getEditorState())
        if (current === null) return false
        const value = historyNavigatorRef.current.previous(inputHistoryRef.current, current)
        if (value === null) return false
        event.preventDefault()
        applyHistory(value)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      event => {
        if (!historyEventAllowed(event) || !historyNavigatorRef.current.isActive()) return false
        const value = historyNavigatorRef.current.next(inputHistoryRef.current)
        if (value === null) return false
        event.preventDefault()
        applyHistory(value)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
    const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
      if (!historyNavigatorRef.current.isActive()) return
      const current = historyTextFromEditor(editorState)
      if (current === appliedHistoryRef.current) return
      historyNavigatorRef.current.reset()
      appliedHistoryRef.current = null
    })
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
          if (messageHasContent(message)) {
            historyNavigatorRef.current.reset()
            appliedHistoryRef.current = null
            submitRef.current(message, event.altKey ? 'followUp' : 'default')
          }
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
      unregisterArrowUp()
      unregisterArrowDown()
      unregisterUpdate()
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
    clear() {
      replaceMarkdownDocument(editor, '')
    },
    restoreMessage(message: LiveMessageDto) {
      restoreMessageBeforeCurrentDraft(editor, message)
    },
  }), [editor])
  return null
}

const LiveMarkdownComposerImpl = forwardRef<LiveMarkdownComposerHandle, LiveMarkdownComposerProps>(function LiveMarkdownComposer({
  draft,
  onDraftPresenceChange,
  draftKey,
  inputHistory,
  commands,
  workspaceReferenceSearch,
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
      <DraftPersistencePlugin draftKey={draftKey}/>
      <ExternalDraftPlugin draft={draft}/>
      <EditablePlugin disabled={disabled}/>
      <WorkspaceReferenceMenuPlugin search={workspaceReferenceSearch}/>
      <CommandMenuPlugin commands={commands}/>
      <KeyboardPlugin canSubmit={canSubmit} onSubmit={onSubmit} onEscape={onEscape} inputHistory={inputHistory}/>
      <ComposerRefPlugin forwardedRef={ref}/>
    </div>
  </LexicalComposer>
})

export const LiveMarkdownComposer = memo(LiveMarkdownComposerImpl)
LiveMarkdownComposer.displayName = 'LiveMarkdownComposer'
