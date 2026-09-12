import { pathToFileURL } from 'node:url'
import type { AgentLensIntegration } from './integration'
import { defineAgentLensIntegration } from './integration'

export async function loadInstalledAgentIntegration(
  entryPath: string,
  expectedIntegrationId: string,
): Promise<AgentLensIntegration> {
  const module = await import(pathToFileURL(entryPath).href)
  const candidate = module.default as Partial<AgentLensIntegration> | undefined
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Installed Integration has no default export: ${expectedIntegrationId}`)
  }
  if (!candidate.manifest || !Array.isArray(candidate.components)) {
    throw new Error(`Installed Integration export is invalid: ${expectedIntegrationId}`)
  }
  if (candidate.manifest.integrationId !== expectedIntegrationId) {
    throw new Error(
      `Installed Integration identity mismatch: ${String(candidate.manifest.integrationId)} != ${expectedIntegrationId}`,
    )
  }

  // Re-run the host-side contract validator even though official bundles
  // construct themselves through defineAgentLensIntegration. This keeps the
  // trust boundary on the AgentLens host, not inside the loaded package.
  return defineAgentLensIntegration(candidate.manifest, candidate.components)
}
