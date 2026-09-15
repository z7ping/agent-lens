import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { LiveAttachmentDescriptorDto, LiveImagePartDto } from '@agent-lens/protocol'
import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'
import type { JSX } from 'react'
import { liveAttachmentPreviewUrl, removeLiveAttachment } from '../client/live-attachments'
import { translateProduct } from '../i18n/runtime'
import { IconButton } from './ui'
import { UiIcon } from './UiIcon'

export interface LiveImageNodeInput {
  attachmentId?: string
  name?: string
  mimeType?: string
  sizeBytes?: number
  previewUrl?: string
}

export type SerializedLiveImageNode = Spread<{
  attachmentId: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}, SerializedLexicalNode>

function formatBytes(sizeBytes?: number): string {
  if (!sizeBytes || sizeBytes < 1024) return sizeBytes ? `${sizeBytes} B` : ''
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function LiveImageBlock({
  attachmentId,
  name,
  sizeBytes,
  previewUrl,
  nodeKey,
}: LiveImageNodeInput & { nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext()
  const ready = Boolean(attachmentId)
  const source = previewUrl || (attachmentId ? liveAttachmentPreviewUrl(attachmentId) : '')
  const summary = [name || translateProduct('common:liveComposer.image'), formatBytes(sizeBytes)]
    .filter(Boolean)
    .join(' · ')

  const remove = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isLiveImageNode(node)) node.remove()
    })
    if (attachmentId) void removeLiveAttachment(attachmentId).catch(() => undefined)
  }

  return <div
    className="live-image-block"
    contentEditable={false}
    data-live-message-part="image"
    data-upload-state={ready ? 'ready' : 'pending'}
  >
    {source
      ? <img className="live-image-preview" src={source} alt="" draggable={false}/>
      : <span className="live-image-preview live-image-preview-empty" aria-hidden="true">
          <UiIcon name="task" size={16}/>
        </span>}
    <span className="live-image-summary">{summary}</span>
    <IconButton
      size="small"
      className="live-image-remove"
      aria-label={translateProduct('common:liveComposer.removeImage')}
      title={translateProduct('common:liveComposer.removeImage')}
      onClick={remove}
    >
      <UiIcon name="close" size={14}/>
    </IconButton>
  </div>
}

export class LiveImageNode extends DecoratorNode<JSX.Element> {
  __attachmentId: string
  __name?: string
  __mimeType?: string
  __sizeBytes?: number
  __previewUrl?: string

  $config() {
    return this.config('live-image', { extends: DecoratorNode })
  }

  static clone(node: LiveImageNode): LiveImageNode {
    return new LiveImageNode({
      attachmentId: node.__attachmentId,
      ...(node.__name ? { name: node.__name } : {}),
      ...(node.__mimeType ? { mimeType: node.__mimeType } : {}),
      ...(node.__sizeBytes !== undefined ? { sizeBytes: node.__sizeBytes } : {}),
      ...(node.__previewUrl ? { previewUrl: node.__previewUrl } : {}),
    }, node.__key)
  }

  static importJSON(serializedNode: SerializedLiveImageNode): LiveImageNode {
    return $createLiveImageNode({
      attachmentId: serializedNode.attachmentId,
      ...(serializedNode.name ? { name: serializedNode.name } : {}),
      ...(serializedNode.mimeType ? { mimeType: serializedNode.mimeType } : {}),
      ...(serializedNode.sizeBytes !== undefined ? { sizeBytes: serializedNode.sizeBytes } : {}),
    }).updateFromJSON(serializedNode)
  }

  constructor(input: LiveImageNodeInput = {}, key?: NodeKey) {
    super(key)
    this.__attachmentId = input.attachmentId ?? ''
    this.__name = input.name
    this.__mimeType = input.mimeType
    this.__sizeBytes = input.sizeBytes
    this.__previewUrl = input.previewUrl
  }

  exportJSON(): SerializedLiveImageNode {
    return {
      ...super.exportJSON(),
      attachmentId: this.getAttachmentId(),
      ...(this.__name ? { name: this.__name } : {}),
      ...(this.__mimeType ? { mimeType: this.__mimeType } : {}),
      ...(this.__sizeBytes !== undefined ? { sizeBytes: this.__sizeBytes } : {}),
    }
  }

  createDOM(_config: EditorConfig): HTMLElement {
    return document.createElement('div')
  }

  updateDOM(): false {
    return false
  }

  isInline(): false {
    return false
  }

  getTextContent(): string {
    return '\uFFFC'
  }

  getAttachmentId(): string {
    return this.getLatest().__attachmentId
  }

  getImagePart(): LiveImagePartDto | null {
    const node = this.getLatest()
    if (!node.__attachmentId) return null
    return {
      type: 'image',
      attachmentId: node.__attachmentId,
      ...(node.__name ? { name: node.__name } : {}),
      ...(node.__mimeType ? { mimeType: node.__mimeType } : {}),
      ...(node.__sizeBytes !== undefined ? { sizeBytes: node.__sizeBytes } : {}),
    }
  }

  setAttachment(descriptor: LiveAttachmentDescriptorDto): void {
    const writable = this.getWritable()
    writable.__attachmentId = descriptor.attachmentId
    writable.__name = descriptor.name
    writable.__mimeType = descriptor.mimeType
    writable.__sizeBytes = descriptor.sizeBytes
    writable.__previewUrl = undefined
  }

  decorate(): JSX.Element {
    const node = this.getLatest()
    return <LiveImageBlock
      attachmentId={node.__attachmentId}
      name={node.__name}
      mimeType={node.__mimeType}
      sizeBytes={node.__sizeBytes}
      previewUrl={node.__previewUrl}
      nodeKey={this.getKey()}
    />
  }
}

export function $createLiveImageNode(input: LiveImageNodeInput = {}): LiveImageNode {
  return $applyNodeReplacement(new LiveImageNode(input))
}

export function $isLiveImageNode(
  node: LexicalNode | null | undefined,
): node is LiveImageNode {
  return node instanceof LiveImageNode
}
