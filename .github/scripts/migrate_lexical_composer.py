from pathlib import Path

component = r'''import { CodeNode } from '@lexical/code'
import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from '@lexical/markdown'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary'
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
import './pi-markdown-composer.css'

export interface PiMarkdownComposerHandle {
  focus(options?: FocusOptions): void
}

export interface PiMarkdownComposerProps {
  value: string
  onChange(value: string): void
  onSubmit(mode: 'default' | 'followUp'): void
  onEscape?: () => void
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
'''

css = r'''@reference "../styles.css";

.pi-markdown-composer {
  position: relative;
  min-width: 0;
}

.pi-markdown-input {
  cursor: text;
  white-space: pre-wrap;
  word-break: break-word;
}

.pi-markdown-input[contenteditable='false'] {
  cursor: default;
  opacity: .68;
}

.pi-markdown-placeholder {
  position: absolute;
  top: 8px;
  left: 0;
  right: 0;
  overflow: hidden;
  color: var(--al-muted);
  font-size: 15px;
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

.pi-md-paragraph { margin: 0 0 4px; }
.pi-md-paragraph:last-child { margin-bottom: 0; }
.pi-md-h1, .pi-md-h2, .pi-md-h3, .pi-md-h4, .pi-md-h5, .pi-md-h6 {
  margin: 5px 0 3px;
  color: var(--al-ink);
  line-height: 1.35;
  font-weight: 700;
}
.pi-md-h1 { font-size: 20px; }
.pi-md-h2 { font-size: 18px; }
.pi-md-h3 { font-size: 16px; }
.pi-md-h4, .pi-md-h5, .pi-md-h6 { font-size: 15px; }

.pi-md-ul, .pi-md-ol {
  margin: 3px 0;
  padding-left: 22px;
}
.pi-md-ul { list-style: disc outside; }
.pi-md-ol { list-style: decimal outside; }
.pi-md-listitem { margin: 1px 0; }
.pi-md-listitem-nested { list-style: none; }
.pi-md-checklist { list-style: none; padding-left: 20px; }
.pi-md-listitem-checked,
.pi-md-listitem-unchecked {
  position: relative;
  list-style: none;
}
.pi-md-listitem-checked::before,
.pi-md-listitem-unchecked::before {
  position: absolute;
  left: -20px;
  top: .15em;
  width: 13px;
  height: 13px;
  border: 1px solid var(--al-line-strong);
  border-radius: 3px;
  content: '';
}
.pi-md-listitem-checked::before {
  border-color: var(--al-accent);
  background: var(--al-accent);
  box-shadow: inset 0 0 0 3px var(--al-surface);
}

.pi-md-quote {
  margin: 4px 0;
  padding-left: 10px;
  border-left: 3px solid var(--al-line-strong);
  color: var(--al-muted-strong);
}

.pi-md-code-block {
  display: block;
  margin: 5px 0;
  padding: 7px 9px;
  overflow-x: auto;
  border: 1px solid var(--al-line);
  border-radius: 8px;
  background: var(--al-soft-2);
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
}
.pi-md-inline-code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--al-soft-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .9em;
}
.pi-md-link { color: var(--al-accent); text-decoration: underline; text-underline-offset: 2px; }
.pi-md-bold { font-weight: 700; }
.pi-md-italic { font-style: italic; }
.pi-md-strikethrough { text-decoration: line-through; }
'''

Path('packages/web/src/components/PiMarkdownComposer.tsx').write_text(component, encoding='utf-8')
Path('packages/web/src/components/pi-markdown-composer.css').write_text(css, encoding='utf-8')

path = Path('packages/web/src/features/PiLivePage.tsx')
text = path.read_text(encoding='utf-8')
text = text.replace("import { useEffect, useMemo, useRef, useState } from 'react'\nimport ReactMarkdown from 'react-markdown'\n", "import { useEffect, useMemo, useRef, useState } from 'react'\n")
text = text.replace("import { ComposerPillSelect } from '../components/ComposerPillSelect'\n", "import { ComposerPillSelect } from '../components/ComposerPillSelect'\nimport { PiMarkdownComposer, type PiMarkdownComposerHandle } from '../components/PiMarkdownComposer'\n")
text = text.replace("type ComposerView = 'edit' | 'preview'\n", "")
text = text.replace("  const inputRef = useRef<HTMLTextAreaElement>(null)\n", "  const inputRef = useRef<PiMarkdownComposerHandle>(null)\n")
text = text.replace("  const [composerView, setComposerView] = useState<ComposerView>('edit')\n", "")
text = text.replace("  const [composing, setComposing] = useState(false)\n", "")
text = text.replace("    setComposerView('edit')\n", "")
text = text.replace("      setComposerView('edit')\n", "")

toolbar_start = text.index('            <div className="pi-live-editor-toolbar" aria-label="Markdown 输入工具">')
expand_button = text.index('              <button\n                type="button"\n                title={composerExpanded', toolbar_start)
text = text[:toolbar_start] + '            <div className="pi-live-editor-toolbar" aria-label="输入区工具">\n' + text[expand_button:]

body_start = text.index("            {composerView === 'preview'", toolbar_start)
body_end = text.index('          </div>\n          <div className="pi-live-compose-bar">', body_start)
replacement = '''            <PiMarkdownComposer
              ref={inputRef}
              value={input}
              onChange={setInput}
              canSubmit={canSend}
              onSubmit={submitMode => void send(submitMode === 'followUp' ? 'followUp' : undefined)}
              onEscape={state?.isStreaming ? () => void stop() : undefined}
              placeholder={inputPlaceholder}
              title="输入 Markdown 会自动格式化 · Enter 发送 · Alt+Enter 完成后继续 · Shift+Enter 换行 · 生成中 Esc 中断"
              ariaLabel="Pi Markdown 富文本输入"
              disabled={runtimeTerminating}
            />
'''
text = text[:body_start] + replacement + text[body_end:]
text = text.replace("onClick={() => { setMode('steer'); setComposerView('edit'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}", "onClick={() => { setMode('steer'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}")
text = text.replace("onClick={() => { setMode('followUp'); setComposerView('edit'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}", "onClick={() => { setMode('followUp'); requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })) }}")
if 'composerView' in text or 'ReactMarkdown' in text or 'setComposing' in text:
    raise SystemExit('legacy preview state remains')
path.write_text(text, encoding='utf-8')

css_path = Path('packages/web/src/components/markdown-content.css')
md_css = css_path.read_text(encoding='utf-8')
md_css = md_css.replace("\n/* Pi 输入框直接接受 Markdown 源文本，不再暴露“编辑/预览”二段式入口。 */\n.pi-live-editor-toolbar > button[aria-label='预览 Markdown'],\n.pi-live-editor-toolbar > button[aria-label='继续编辑 Markdown'] { display: none; }\n", "\n")
css_path.write_text(md_css, encoding='utf-8')

contract = Path('packages/web/src/features/pi-live-composer-contract.test.ts')
source = contract.read_text(encoding='utf-8')
source = source.replace("const markdownCss = readFileSync(new URL('../components/markdown-content.css', import.meta.url), 'utf8')\n", "const composer = readFileSync(new URL('../components/PiMarkdownComposer.tsx', import.meta.url), 'utf8')\n")
old_test = '''test('Pi Live composer accepts Markdown source directly without exposing a preview toggle', () => {
  assert.match(page, /aria-label="Pi Markdown 输入"/)
  assert.match(page, /title="Enter 发送 · Alt\\+Enter 完成后继续 · Shift\\+Enter 换行 · 生成中 Esc 中断"/)
  assert.match(markdownCss, /button\\[aria-label='预览 Markdown'\\],[\\s\\S]*?display:\\s*none;/)
})'''
new_test = '''test('Pi Live composer uses Lexical Markdown shortcuts and keeps Markdown as the runtime value', () => {
  assert.match(page, /<PiMarkdownComposer/)
  assert.match(page, /ariaLabel="Pi Markdown 富文本输入"/)
  assert.doesNotMatch(page, /composerView|ReactMarkdown|<textarea[^>]*className="pi-live-input"/)
  assert.match(composer, /MarkdownShortcutPlugin transformers=\\{TRANSFORMERS\\}/)
  assert.match(composer, /\\$convertToMarkdownString\\(TRANSFORMERS/)
  assert.match(composer, /\\$convertFromMarkdownString\\(value, TRANSFORMERS/)
  assert.match(composer, /KEY_ENTER_COMMAND/)
  assert.match(composer, /event\\.isComposing/)
  assert.match(composer, /event\\.altKey \\? 'followUp' : 'default'/)
})'''
if old_test not in source:
    raise SystemExit('composer contract block not found')
contract.write_text(source.replace(old_test, new_test), encoding='utf-8')
