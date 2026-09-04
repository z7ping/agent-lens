import { randomUUID } from 'node:crypto'
import { asPiSdkExtensionUiContext, type PiSdkExtensionUiContext } from './pi-sdk-adapter'

interface PendingRequest {
  resolve(response: Record<string, unknown>): void
  defaultValue: unknown
  timer?: ReturnType<typeof setTimeout> | undefined
  signal?: AbortSignal | undefined
  onAbort?: (() => void) | undefined
}

interface DialogOptions {
  signal?: AbortSignal | undefined
  timeout?: number | undefined
}

export interface PiExtensionUiBridgeOptions {
  publish(event: Record<string, unknown>): void
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function fallbackTheme(): Record<string, unknown> {
  const decorate = (...args: unknown[]) => {
    const value = args.at(-1)
    return typeof value === 'string' ? value : String(value ?? '')
  }
  return new Proxy({ fg: decorate, bg: decorate, bold: decorate, italic: decorate, underline: decorate }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target]
      return decorate
    },
  })
}

export class PiExtensionUiBridge {
  private readonly pending = new Map<string, PendingRequest>()
  private editorText = ''
  private disposed = false
  readonly context: PiSdkExtensionUiContext

  constructor(private readonly options: PiExtensionUiBridgeOptions) {
    const theme = fallbackTheme()
    const context: Record<string, unknown> = {
      select: (title: string, choices: string[], dialog?: DialogOptions) => this.dialog(
        'select',
        { title, options: choices, timeout: dialog?.timeout },
        dialog,
        undefined,
        response => response.cancelled === true
          ? undefined
          : typeof response.value === 'string' ? response.value : undefined,
      ),
      confirm: (title: string, message: string, dialog?: DialogOptions) => this.dialog(
        'confirm',
        { title, message, timeout: dialog?.timeout },
        dialog,
        false,
        response => response.cancelled === true ? false : response.confirmed === true,
      ),
      input: (title: string, placeholder?: string, dialog?: DialogOptions) => this.dialog(
        'input',
        { title, placeholder, timeout: dialog?.timeout },
        dialog,
        undefined,
        response => response.cancelled === true
          ? undefined
          : typeof response.value === 'string' ? response.value : undefined,
      ),
      notify: (message: string, type?: string) => this.fire({
        method: 'notify',
        message,
        ...(type ? { notifyType: type } : {}),
      }),
      onTerminalInput: () => () => {},
      setStatus: (key: string, text?: string) => this.fire({
        method: 'setStatus',
        statusKey: key,
        statusText: text,
      }),
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key: string, content: unknown, widgetOptions?: Record<string, unknown>) => {
        if (content === undefined || (Array.isArray(content) && content.every(item => typeof item === 'string'))) {
          this.fire({
            method: 'setWidget',
            widgetKey: key,
            widgetLines: content,
            ...(typeof widgetOptions?.placement === 'string' ? { widgetPlacement: widgetOptions.placement } : {}),
          })
        }
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title: string) => this.fire({ method: 'setTitle', title }),
      custom: async () => undefined,
      pasteToEditor: (text: string) => this.setEditorText(text),
      setEditorText: (text: string) => this.setEditorText(text),
      getEditorText: () => this.editorText,
      editor: (title: string, prefill?: string) => this.dialog(
        'editor',
        { title, prefill },
        undefined,
        undefined,
        response => response.cancelled === true
          ? undefined
          : typeof response.value === 'string' ? response.value : undefined,
      ),
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not supported by the AgentLens web bridge' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    }
    this.context = asPiSdkExtensionUiContext(context)
  }

  respond(requestId: string, response: unknown): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.cleanup(requestId, pending)
    pending.resolve(record(response))
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, pending] of this.pending) {
      this.cleanup(id, pending)
      pending.resolve({ cancelled: true })
    }
    this.pending.clear()
  }

  private fire(payload: Record<string, unknown>): void {
    if (this.disposed) return
    this.options.publish({
      type: 'extension_ui_request',
      id: randomUUID(),
      ...payload,
    })
  }

  private setEditorText(text: string): void {
    this.editorText = text
    this.fire({ method: 'set_editor_text', text })
  }

  private dialog<T>(
    method: string,
    payload: Record<string, unknown>,
    dialog: DialogOptions | undefined,
    defaultValue: T,
    parse: (response: Record<string, unknown>) => T,
  ): Promise<T> {
    if (this.disposed || dialog?.signal?.aborted) return Promise.resolve(defaultValue)
    const id = randomUUID()
    return new Promise<T>(resolveRequest => {
      const pending: PendingRequest = {
        defaultValue,
        signal: dialog?.signal,
        resolve: response => resolveRequest(parse(response)),
      }
      const onAbort = () => {
        const current = this.pending.get(id)
        if (!current) return
        this.cleanup(id, current)
        resolveRequest(defaultValue)
      }
      pending.onAbort = onAbort
      dialog?.signal?.addEventListener('abort', onAbort, { once: true })
      if (dialog?.timeout && dialog.timeout > 0) {
        pending.timer = setTimeout(onAbort, dialog.timeout)
      }
      this.pending.set(id, pending)
      this.options.publish({
        type: 'extension_ui_request',
        id,
        method,
        ...payload,
      })
    })
  }

  private cleanup(id: string, pending: PendingRequest): void {
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort)
  }
}
