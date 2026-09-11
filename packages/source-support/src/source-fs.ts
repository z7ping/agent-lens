export function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function sourceFileIdentity(value: { dev: number; ino: number }): string {
  return `${value.dev}:${value.ino}`
}
