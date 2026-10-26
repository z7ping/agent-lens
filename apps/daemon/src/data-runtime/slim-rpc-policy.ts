/** Explicit IPC method allowlist for replacement storage. Reflection into
 * internal SqliteExecutor / better-sqlite3 must NEVER be reachable from a
 * local web request, even when TypeScript marks a property private.
 */
const methods:Readonly<Record<string,readonly string[]>>={
  nativeSessionCatalog:['upsert','get','getByReviewSessionId','query',
    'isNativeMetricsEligible'],
  nativeSessionMetrics:['replace','get','overview','findRebuildCandidates','invalidate'],
  nativeSessionList:['query'],
  nativeSessionContexts:['get','upsert'],
  identity:['resolveHost','resolveInstallation','resolveProject','resolveWorkspace'],
  assets:['resolveDefinition','resolveBinding','recordState'],
  assetInventory:['listByInstallation'],
  launchableProjects:['query','recordWorkspaceValidation','rebuild'],
  runtimeProfiles:['get','resolve'],
  checkpoints:['get','getWithRevision','compareAndSet','set','clear'],
}

export function slimStorageRootAllowed(path:readonly string[]):boolean {
  if(path.length===1 && path[0]==='health')return true
  if(path[0]==='repositories'){
    return path.length===3 && ['hosts','installations'].includes(path[1]!)
      && path[2]==='get'
  }
  return path.length===2 && Boolean(methods[path[0]!] && methods[path[0]!]!.includes(path[1]!))
}
