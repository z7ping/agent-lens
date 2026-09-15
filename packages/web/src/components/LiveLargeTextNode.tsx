import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
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
import { translateProduct } from '../i18n/runtime'
import { IconButton } from './ui'
import { UiIcon } from './UiIcon'

export type SerializedLiveLargeTextNode = Spread<{
  text: string
}, SerializedLexicalNode>

function LiveLargeTextBlock({
  text,
  nodeKey,
}: {
  text: string
  nodeKey: NodeKey
}) {
  const [editor] = useLexicalComposerContext()
  const lineCount = text.split(/\r\n|\r|\n/).length
  const charCount = text.length

  const remove = () => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey)
      if ($isLiveLargeTextNode(node)) node.remove()
    })
  }

  return <div
    className="live-large-text-block"
    contentEditable={false}
    data-live-message-part="large-text"
  >
    <span className="live-large-text-icon" aria-hidden="true">
      <UiIcon name="task" size={14}/>
    </span>
    <span className="live-large-text-summary">
      {translateProduct('common:liveComposer.largeTextSummary', {
        lines: lineCount,
        chars: charCount,
      })}
    </span>
    <IconButton
      size="small"
      className="live-large-text-remove"
      aria-label={translateProduct('common:liveComposer.removeLargeText')}
      title={translateProduct('common:liveComposer.removeLargeText')}
      onClick={remove}
    >
      <UiIcon name="close" size={14}/>
    </IconButton>
  </div>
}

export class LiveLargeTextNode extends DecoratorNode<JSX.Element> {
  __text: string

  $config() {
    return this.config('live-large-text', { extends: DecoratorNode })
  }

  static clone(node: LiveLargeTextNode): LiveLargeTextNode {
    return new LiveLargeTextNode(node.__text, node.__key)
  }

  static importJSON(serializedNode: SerializedLiveLargeTextNode): LiveLargeTextNode {
    return $createLiveLargeTextNode(serializedNode.text).updateFromJSON(serializedNode)
  }

  constructor(text: string, key?: NodeKey) {
    super(key)
    this.__text = text
  }

  exportJSON(): SerializedLiveLargeTextNode {
    return {
      ...super.exportJSON(),
      text: this.getText(),
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

  getText(): string {
    return this.getLatest().__text
  }

  getTextContent(): string {
    return this.getText()
  }

  decorate(): JSX.Element {
    return <LiveLargeTextBlock text={this.getText()} nodeKey={this.getKey()}/>
  }
}

export function $createLiveLargeTextNode(text: string): LiveLargeTextNode {
  return $applyNodeReplacement(new LiveLargeTextNode(text))
}

export function $isLiveLargeTextNode(
  node: LexicalNode | null | undefined,
): node is LiveLargeTextNode {
  return node instanceof LiveLargeTextNode
}
