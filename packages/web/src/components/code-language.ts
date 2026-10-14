/** Syntax highlighting must follow explicit language evidence, not arbitrary logs. */
const aliases: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', typescript: 'typescript',
  jsx: 'jsx', tsx: 'tsx', json: 'json', jsonc: 'json',
  bash: 'bash', sh: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  ps1: 'powershell', pwsh: 'powershell', powershell: 'powershell',
  py: 'python', python: 'python', java: 'java',
  sql: 'sql', yml: 'yaml', yaml: 'yaml',
  xml: 'markup', html: 'markup', svg: 'markup', markup: 'markup',
  css: 'css', diff: 'diff',
}

export function normalizedCodeLanguage(value?: string): string | undefined {
  if (!value) return undefined
  return aliases[value.toLowerCase().trim().replace(/^language-/, '')]
}

/** Parse exact JSON content; don't color arbitrary diagnostic text as JSON. */
export function codeLanguageFromContent(text: string, fallback?: string): string | undefined {
  const trimmed = text.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json' } catch { /* preserve plain text */ }
  }
  return normalizedCodeLanguage(fallback)
}
