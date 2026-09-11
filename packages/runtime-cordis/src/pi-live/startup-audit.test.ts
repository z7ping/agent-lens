import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentLensContext } from '../context'
import { createPiLiveStartupAuditSink } from './startup-audit'

test('Pi startup audit reuses Source detection identity and commits runtime evidence', async () => {
  const commits: unknown[] = []
  const installationInputs: unknown[] = []
  const detected = {
    sourceId: 'pi',
    productId: 'pi',
    executable: process.platform === 'win32' ? 'C:\\tools\\pi.cmd' : '/usr/local/bin/pi',
    version: '0.85.1',
    configRoot: process.platform === 'win32' ? 'C:\\Users\\tester\\.pi' : '/home/tester/.pi',
    dataRoot: process.platform === 'win32' ? 'C:\\Users\\tester\\.pi\\sessions' : '/home/tester/.pi/sessions',
    confidence: 'exact' as const,
  }
  const host = {
    id: 'host-1',
    nodeId: 'node-1',
    name: 'test-host',
    platform: process.platform,
    arch: process.arch,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  }
  const installation = {
    id: 'installation-pi-1',
    hostId: host.id,
    productId: 'pi',
    executable: detected.executable,
    version: detected.version,
    configRoot: detected.configRoot,
    dataRoot: detected.dataRoot,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  }

  const ctx = {
    sources: {
      list: () => [{
        manifest: { sourceId: 'pi' },
        detect: async () => [detected],
      }],
    },
    identity: {
      resolveHost: async () => host,
      resolveInstallation: async (input: unknown) => {
        installationInputs.push(input)
        return installation
      },
    },
    capturePolicy: {
      sanitizeNormalizedOutput: (value: unknown) => value,
    },
    observations: {
      commit: async (input: unknown) => {
        commits.push(input)
        return { observation: { id: 'observation-1' }, evidence: [] }
      },
    },
  } as unknown as AgentLensContext

  const sink = createPiLiveStartupAuditSink(ctx)
  await sink.recordStartupResources({
    runtimeSessionId: 'runtime-1',
    attemptStartedAt: '2026-09-11T10:00:00.000Z',
    capturedAt: '2026-09-11T10:00:01.000Z',
    nativeSessionId: 'native-session-1',
    workspacePath: process.platform === 'win32' ? 'C:\\workspace\\agent-lens' : '/workspace/agent-lens',
    executable: detected.executable,
    sdkVersion: '0.85.1',
    sessionName: 'AgentLens task',
    startupResources: {
      contexts: ['AGENTS.md'],
      skills: ['repo-review'],
      prompts: ['release'],
      extensions: ['example-extension'],
      themes: ['dark'],
      diagnostics: [],
    },
  })

  assert.deepEqual(installationInputs, [{
    hostId: host.id,
    productId: detected.productId,
    executable: detected.executable,
    version: detected.version,
    configRoot: detected.configRoot,
    dataRoot: detected.dataRoot,
  }])
  assert.equal(commits.length, 1)
  const commit = commits[0] as {
    sourceId: string
    installation: { id: string }
    candidate: {
      kind: string
      nativeEventId?: string
      identityHints: { nativeSessionId?: string; workspacePath?: string }
      payload: Record<string, unknown>
    }
    evidenceCandidates: Array<{
      captureMethod: string
      derivation: string
      nativeStableId?: string
      sourceLocator?: { kind: string; hookEventId?: string }
    }>
  }
  assert.equal(commit.sourceId, 'pi')
  assert.equal(commit.installation.id, installation.id)
  assert.equal(commit.candidate.kind, 'runtime.resources')
  assert.equal(commit.candidate.identityHints.nativeSessionId, 'native-session-1')
  assert.match(commit.candidate.nativeEventId ?? '', /^pi-live:runtime-1:startup-resources:/)
  assert.deepEqual(commit.candidate.payload.resources, {
    contexts: ['AGENTS.md'],
    skills: ['repo-review'],
    prompts: ['release'],
    extensions: ['example-extension'],
    themes: ['dark'],
    diagnostics: [],
  })
  assert.equal(commit.evidenceCandidates[0]?.captureMethod, 'runtime-hook')
  assert.equal(commit.evidenceCandidates[0]?.derivation, 'observed')
  assert.equal(commit.evidenceCandidates[0]?.nativeStableId, commit.candidate.nativeEventId)
  assert.equal(commit.evidenceCandidates[0]?.sourceLocator?.kind, 'runtime-hook')
})
