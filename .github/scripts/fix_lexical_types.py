from pathlib import Path

path = Path('packages/web/src/components/PiMarkdownComposer.tsx')
text = path.read_text(encoding='utf-8')
text = text.replace("import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary'", "import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'")
text = text.replace("  onEscape?: () => void\n", "  onEscape: (() => void) | undefined\n")
path.write_text(text, encoding='utf-8')
