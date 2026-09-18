import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentDetailResponseDto,
  type AgentOverviewDto,
  type AgentSummaryResponseDto,
  type CapturePolicyResponseDto,
  type IntegrationManagementResponseDto,
} from '@agent-lens/protocol'
import { AgentLensApi } from './api'
import { AgentLensClientModel } from './model'

const meta = { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-08T00:00:00.000Z' }

const summaries: AgentSummaryResponseDto = {
  items: [{
    sourceId: 'pi',
    productId: 'pi',
    displayName: 'Pi',
    supported: true,
    enabled: true,
    detected: true,
    installationIds: ['pi-1'],
    installationCount: 1,
  }],
  meta,
}

const detailItem: AgentOverviewDto = {
  sourceId: 'pi',
  productId: 'pi',
  displayName: 'Pi',
  supported: true,
  enabled: true,
  detected: true,
  installations: [{
    id: 'pi-1',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-08T00:00:00.000Z',
  }],
  capabilities: [],
  assetInventory: [],
  usedAssets: [],
  assetInventoryStatus: 'available',
}

const integrationManagementResponse: IntegrationManagementResponseDto = {
  items: [],
  discovery: {
    status: 'complete',
    generatedAt: '2026-09-12T00:00:00.000Z',
  },
  preferences: {
    onboarding: { completed: true },
    displayOrder: [],
    displayOrderConfigured: true,
    acknowledgedIntegrationIds: [],
    updatedAt: '2026-09-12T00:00:00.000Z',
  },
  meta: {
    protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
    generatedAt: '2026-09-12T00:00:00.000Z',
  },
}

class PendingAgentsApi extends AgentLensApi {
  private resolveSummary: ((value: AgentSummaryResponseDto) => void) | null = null

  override agentSummaries(): Promise<AgentSummaryResponseDto> {
    return new Promise(resolve => { this.resolveSummary = resolve })
  }

  override capturePolicy(): Promise<CapturePolicyResponseDto> {
    return Promise.reject(new Error('测试中不加载采集策略'))
  }

  override integrations(): Promise<IntegrationManagementResponseDto> {
    return Promise.resolve(integrationManagementResponse)
  }

  complete(): void {
    this.resolveSummary?.(summaries)
  }
}

test('智能体 Summary 尚未完成时保持加载态，不等待完整 Detail', async () => {
  const api = new PendingAgentsApi()
  const model = new AgentLensClientModel(api)
  const pending = model.refreshAgents()

  assert.equal(model.getSnapshot().agentsLoading, true)
  assert.equal(model.getSnapshot().agentsError, '')
  assert.equal(model.getSnapshot().agentSummaries, null)
  assert.equal(model.getSnapshot().agents, null)

  api.complete()
  await pending

  assert.equal(model.getSnapshot().agentsLoading, false)
  assert.deepEqual(model.getSnapshot().agentSummaries, summaries)
  assert.equal(model.getSnapshot().agents, null)
})

test('当前智能体 Detail 按 sourceId 精准读取并缓存到已加载详情', async () => {
  let detailCalls = 0
  class DetailApi extends PendingAgentsApi {
    override agentSummaries(): Promise<AgentSummaryResponseDto> {
      return Promise.resolve(summaries)
    }

    override agentDetail(sourceId: string): Promise<AgentDetailResponseDto | null> {
      detailCalls += 1
      return Promise.resolve({ item: { ...detailItem, sourceId }, meta })
    }
  }

  const model = new AgentLensClientModel(new DetailApi())
  await model.refreshAgents()
  await model.ensureAgentDetail('pi')
  await model.ensureAgentDetail('pi')

  assert.equal(detailCalls, 1)
  assert.equal(model.getSnapshot().agents?.items[0]?.sourceId, 'pi')
  assert.equal(model.getSnapshot().agentDetailLoadingSourceId, '')
})

test('Summary 成功后才启动 Capture Policy / Integration 辅助读取', async () => {
  let supportReads = 0
  class SequencedApi extends AgentLensApi {
    override agentSummaries(): Promise<AgentSummaryResponseDto> {
      return Promise.resolve(summaries)
    }
    override capturePolicy(): Promise<CapturePolicyResponseDto> {
      supportReads += 1
      return Promise.reject(new Error('not needed'))
    }
    override integrations(): Promise<IntegrationManagementResponseDto> {
      supportReads += 1
      return Promise.resolve(integrationManagementResponse)
    }
  }

  const model = new AgentLensClientModel(new SequencedApi())
  await model.refreshAgents()

  assert.deepEqual(model.getSnapshot().agentSummaries, summaries)
  assert.equal(supportReads, 2)
  assert.deepEqual(model.getSnapshot().integrationManagement, integrationManagementResponse)
})

test('Summary 失败时进入错误态且不继续启动辅助读取', async () => {
  let supportReads = 0
  class FailingSummaryApi extends AgentLensApi {
    override agentSummaries(): Promise<AgentSummaryResponseDto> {
      return Promise.reject(new Error('summary unavailable'))
    }
    override capturePolicy(): Promise<CapturePolicyResponseDto> {
      supportReads += 1
      return Promise.reject(new Error('should not run'))
    }
    override integrations(): Promise<IntegrationManagementResponseDto> {
      supportReads += 1
      return Promise.resolve(integrationManagementResponse)
    }
  }

  const model = new AgentLensClientModel(new FailingSummaryApi())
  await model.refreshAgents()

  assert.equal(model.getSnapshot().agentsLoading, false)
  assert.equal(model.getSnapshot().agentSummaries, null)
  assert.equal(supportReads, 0)
  assert.equal(model.getSnapshot().agentsError, '智能体概览查询失败。请重试；若持续失败，请运行诊断命令。')
})
