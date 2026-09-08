import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_LENS_PROTOCOL_VERSION, type AgentOverviewResponseDto, type CapturePolicyResponseDto } from '@agent-lens/protocol'
import { AgentLensApi } from './api'
import { AgentLensClientModel } from './model'

const agentsResponse: AgentOverviewResponseDto = {
  items: [],
  meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, generatedAt: '2026-09-08T00:00:00.000Z' },
}

class PendingAgentsApi extends AgentLensApi {
  private resolveAgents: ((value: AgentOverviewResponseDto) => void) | null = null

  override agents(): Promise<AgentOverviewResponseDto> {
    return new Promise(resolve => { this.resolveAgents = resolve })
  }

  override capturePolicy(): Promise<CapturePolicyResponseDto> {
    return Promise.reject(new Error('测试中不加载采集策略'))
  }

  complete(): void {
    this.resolveAgents?.(agentsResponse)
  }
}

class FailingAgentsApi extends AgentLensApi {
  override agents(): Promise<AgentOverviewResponseDto> {
    return Promise.reject(new Error('agents unavailable'))
  }

  override capturePolicy(): Promise<CapturePolicyResponseDto> {
    return Promise.reject(new Error('测试中不加载采集策略'))
  }
}

test('智能体概览在请求尚未完成时保持加载态，而非错误态', async () => {
  const api = new PendingAgentsApi()
  const model = new AgentLensClientModel(api)
  const pending = model.refreshAgents()

  assert.equal(model.getSnapshot().agentsLoading, true)
  assert.equal(model.getSnapshot().agentsError, '')
  assert.equal(model.getSnapshot().agents, null)

  api.complete()
  await pending

  assert.equal(model.getSnapshot().agentsLoading, false)
  assert.equal(model.getSnapshot().agentsError, '')
  assert.deepEqual(model.getSnapshot().agents, agentsResponse)
})

test('智能体概览仅在请求真实失败后进入错误态', async () => {
  const model = new AgentLensClientModel(new FailingAgentsApi())

  await model.refreshAgents()

  assert.equal(model.getSnapshot().agentsLoading, false)
  assert.equal(model.getSnapshot().agents, null)
  assert.equal(model.getSnapshot().agentsError, '智能体概览查询失败。请重试；若持续失败，请运行诊断命令。')
})
