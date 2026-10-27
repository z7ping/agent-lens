import { relative } from 'node:path'

/**
 * npm accepts relative file: specs. Normalize path separators, not via URL
 * encoding: DOS 8.3 names (~), spaces and Unicode must remain literal.
 * The injectable relative resolver makes the Windows behavior testable on any OS.
 */
export function npmLocalTarballSpecifier(consumerDir, tarballPath, relativePath = relative) {
  return 'file:' + relativePath(consumerDir, tarballPath).replaceAll('\\', '/')
}
