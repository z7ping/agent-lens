from pathlib import Path

markdown = Path('packages/web/src/components/MarkdownContent.tsx')
text = markdown.read_text(encoding='utf-8')
text = text.replace("import './markdown-content.css'\n", '')
markdown.write_text(text, encoding='utf-8')

composer = Path('packages/web/src/components/PiMarkdownComposer.tsx')
text = composer.read_text(encoding='utf-8')
text = text.replace("import './pi-markdown-composer.css'\n", '')
composer.write_text(text, encoding='utf-8')

main = Path('packages/web/src/main.tsx')
text = main.read_text(encoding='utf-8')
anchor = "import './pi-live.css'\n"
replacement = "import './pi-live.css'\nimport './components/markdown-content.css'\nimport './components/pi-markdown-composer.css'\n"
if anchor not in text:
    raise SystemExit('main CSS import anchor not found')
if "./components/markdown-content.css" not in text:
    text = text.replace(anchor, replacement)
main.write_text(text, encoding='utf-8')
