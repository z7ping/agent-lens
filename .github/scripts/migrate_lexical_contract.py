from pathlib import Path

path = Path('scripts/check-pi-live-contract.mjs')
text = path.read_text(encoding='utf-8')
old_decl = "const [app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskDetailCss, reviewPage, page, piTaskRound, piTaskProjection, hubPage, history, piNative, client, css, http, runtime, workerHost, workerEntry, inProcessHost, sdkLoader, sdkAdapter, runtimePackage, coreObservation, timelineProtocol] = await Promise.all(["
new_decl = "const [app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskDetailCss, reviewPage, page, piComposer, piTaskRound, piTaskProjection, hubPage, history, piNative, client, css, http, runtime, workerHost, workerEntry, inProcessHost, sdkLoader, sdkAdapter, runtimePackage, coreObservation, timelineProtocol] = await Promise.all(["
if old_decl not in text:
    raise SystemExit('Pi Live contract destructuring not found')
text = text.replace(old_decl, new_decl)
old_read = "  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/features/PiLiveTaskRound.tsx', import.meta.url), 'utf8'),"
new_read = "  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/components/PiMarkdownComposer.tsx', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/features/PiLiveTaskRound.tsx', import.meta.url), 'utf8'),"
if old_read not in text:
    raise SystemExit('PiLivePage read block not found')
text = text.replace(old_read, new_read)
old_checks = "requireText(page, /onCompositionStart/, '输入框缺少 compositionstart 保护')\nrequireText(page, /nativeEvent\\.isComposing/, '输入框缺少 isComposing 保护')\nrequireText(page, /keyCode === 229/, '输入框缺少 IME 229 兼容')"
new_checks = "requireText(piComposer, /KEY_ENTER_COMMAND/, 'Lexical 输入框缺少 Enter 命令边界')\nrequireText(piComposer, /event\\.isComposing/, 'Lexical 输入框缺少 isComposing 保护')\nrequireText(piComposer, /keyCode === 229/, 'Lexical 输入框缺少 IME 229 兼容')"
if old_checks not in text:
    raise SystemExit('legacy IME contract checks not found')
text = text.replace(old_checks, new_checks)
path.write_text(text, encoding='utf-8')
