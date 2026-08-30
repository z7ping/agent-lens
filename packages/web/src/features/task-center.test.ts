import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectFacetDto, ReviewSessionSummaryDto } from '@agent-lens/protocol'
import { deriveTaskProjectOptions, pickTaskProject } from './task-center'

function session(overrides: Partial<ReviewSessionSummaryDto>): ReviewSessionSummaryDto {
  return {
    id: 'session-1',
    installationId: 'installation-1',
    productId: 'pi',
    sourceIds: ['pi'],
    startedAt: '2026-08-30T08:00:00.000Z',
    endedAt: '2026-08-30T09:00:00.000Z',
    durationMs: 3_600_000,
    observationCount: 1,
    interactionCount: 1,
    toolCount: 0,
    errorCount: 0,
    hasErrors: false,
    ...overrides,
  }
}

test('任务中心只从真实历史会话提取工作目录，不根据 ProjectFacet 猜路径', () => {
  const projects: ProjectFacetDto[] = [
    { id: 'agent-lens', name: 'AgentLens', repositoryIdentity: 'z7ping/agent-lens' },
    { id: 'narratica', name: 'Narratica', repositoryIdentity: 'z7ping/narratica' },
  ]
  const options = deriveTaskProjectOptions(projects, [
    session({ projectId: 'agent-lens', projectName: '旧名称', workspacePath: 'F:\\workspace\\agent-lens' }),
  ])
  assert.deepEqual(options.map(option => ({ label: option.label, cwd: option.cwd })), [
    { label: 'AgentLens', cwd: 'F:\\workspace\\agent-lens' },
  ])
})

test('同一项目优先使用最近一次真实会话的 workspacePath', () => {
  const options = deriveTaskProjectOptions([{ id: 'agent-lens', name: 'AgentLens' }], [
    session({ id: 'old', projectId: 'agent-lens', workspacePath: 'F:\\old\\agent-lens', endedAt: '2026-08-29T09:00:00.000Z' }),
    session({ id: 'new', projectId: 'agent-lens', workspacePath: 'F:\\workspace\\agent-lens', endedAt: '2026-08-30T09:00:00.000Z' }),
  ])
  assert.equal(options.length, 1)
  assert.equal(options[0]?.cwd, 'F:\\workspace\\agent-lens')
})

test('没有 projectId 时仍可用已观测 workspacePath 建立项目选项', () => {
  const options = deriveTaskProjectOptions([], [
    session({ projectName: 'Slowlight', workspacePath: '/workspace/slowlight' }),
  ])
  assert.equal(options[0]?.label, 'Slowlight')
  assert.equal(options[0]?.cwd, '/workspace/slowlight')
})

test('新建相关任务优先继承当前项目，其次继承工作目录', () => {
  const options = deriveTaskProjectOptions([], [
    session({ id: 'a', projectId: 'project-a', projectName: 'A', workspacePath: '/work/a', endedAt: '2026-08-29T09:00:00.000Z' }),
    session({ id: 'b', projectId: 'project-b', projectName: 'B', workspacePath: '/work/b', endedAt: '2026-08-30T09:00:00.000Z' }),
  ])
  assert.equal(pickTaskProject(options, 'project-a')?.cwd, '/work/a')
  assert.equal(pickTaskProject(options, undefined, '/work/a')?.label, 'A')
  assert.equal(pickTaskProject(options)?.label, 'B')
})
