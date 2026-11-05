/** Only derive preview targets from a verified absolute workspace root and
 * a workspace-relative source path. The host preview endpoint owns final
 * file existence, redaction, size and symlink checks. */
export function workspaceFilePreviewPath(
  rootPath: string | undefined,
  path: string,
): string | undefined {
  if (!rootPath || !path || rootPath.includes('\0') || path.includes('\0')) return undefined
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root || !(/^[A-Za-z]:\//.test(root) || root.startsWith('/'))) return undefined
  const normalized = path.replace(/\\/g, '/')
  if (/^[A-Za-z]:[^/]/.test(normalized)) return undefined
  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
  const prefix = root + '/'
  const caseInsensitive = /^[A-Za-z]:\//.test(root)
  const left = caseInsensitive ? normalized.toLowerCase() : normalized
  const rootPrefix = caseInsensitive ? prefix.toLowerCase() : prefix
  const relative = absolute
    ? left.startsWith(rootPrefix) ? normalized.slice(prefix.length) : ''
    : normalized.replace(/^(?:\.\/)+/, '')
  if (!relative || (absolute && !left.startsWith(rootPrefix))) return undefined
  const segments = relative.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) return undefined
  return root + '/' + segments.join('/')
}
