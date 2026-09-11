import {
  AGENT_LENS_PROTOCOL_VERSION,
  type AgentOverviewResponseDto,
  type IntegrationManagementItemDto,
  IntegrationManagementResponseDto,
  IntegrationPackageOperationResponseDto,
} from '@agent-lens/protocol'

type FetchLike = typeof fetch

export interface PluginCommandOptions {
  apiUrl(pathname: string): string
  fetchImpl?: FetchLike
  print?: (line: string) => void
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizePluginId(value: string | undefined): string {
  const id = String(value ?? '').trim().toLowerCase()
  if (!id) throw new Error('请提供 Integration ID，例如：agent-lens plugin install pi')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error('Integration ID 只能包含字母、数字、点、下划线和连字符')
  }
  return id
}

function assertProtocol(payload: unknown): void {
  const body = record(payload)
  const meta = record(body?.meta)
  const version = meta?.protocolVersion
  if (version !== AGENT_LENS_PROTOCOL_VERSION) {
    throw new Error(
      `AgentLens 协议不兼容：期望 ${AGENT_LENS_PROTOCOL_VERSION}，实际 ${String(version ?? 'unknown')}`,
    )
  }
}

function apiErrorMessage(status: number, payload: unknown): string {
  const body = record(payload)
  const code = typeof body?.error === 'string' ? body.error : ''
  const message = typeof body?.message === 'string' ? body.message : ''
  if (code === 'integration_package_lifecycle_unavailable') {
    return 'Integration Package Lifecycle 当前不可用'
  }
  if (code === 'integration_not_found') return '未找到该官方 Integration'
  if (code === 'integration_operation_not_found') return '未找到该 Integration 操作'
  return message || code || `HTTP ${status}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    })
  } catch (error) {
    throw new Error(
      `无法连接 AgentLens 运行时：${error instanceof Error ? error.message : String(error)}。请先启动桌面端或 agent-lens service start。`,
    )
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    if (response.ok) throw new Error('AgentLens API 返回了无效 JSON')
  }

  if (!response.ok) {
    throw new Error(`AgentLens API 请求失败（${response.status}）：${apiErrorMessage(response.status, payload)}`)
  }
  assertProtocol(payload)
  return payload as T
}

function toolLabel(item: IntegrationManagementItemDto): string {
  const presence = item.tool?.presence
  if (presence === 'present') return '已发现'
  if (presence === 'data-only') return '发现历史数据'
  if (presence === 'error') return '扫描失败'
  if (presence === 'absent') return '未发现'
  return '未扫描'
}

function enabledLabel(item: IntegrationManagementItemDto): string {
  const configured = item.enabled.configured
  if (item.enabled.restartRequired || configured !== item.enabled.effective) {
    return configured ? '已开启（待重启）' : '已关闭（待重启）'
  }
  return configured ? '已开启' : '已关闭'
}

function availabilityLabel(value: IntegrationManagementItemDto['availability']): string {
  if (value === 'available') return '可用'
  if (value === 'partial') return '部分可用'
  if (value === 'error') return '异常'
  return '不可用'
}

function packageLabel(item: IntegrationManagementItemDto): string {
  const state = item.packageState
  if (!state) return '包状态不可用'
  if (!state.installed) {
    return state.reason ? `未安装（${state.reason}）` : '未安装'
  }
  const version = state.installedVersion ? ` ${state.installedVersion}` : ''
  const warnings: string[] = []
  if (state.compatibility !== 'compatible') warnings.push(`兼容性=${state.compatibility}`)
  if (state.integrity !== 'verified') warnings.push(`完整性=${state.integrity}`)
  if (state.restartRequired) warnings.push('待重启')
  return `已安装${version}${warnings.length ? `（${warnings.join('，')}）` : ''}`
}

function detectedState(
  item: IntegrationManagementItemDto,
  agents: AgentOverviewResponseDto | null,
): boolean | null {
  const agent = agents?.items.find(candidate =>
    candidate.productId === item.productId
    || candidate.sourceId === item.integrationId
  )
  return agent ? agent.detected : null
}

function detectedLabel(value: boolean | null): string {
  return value === true ? '已检测' : value === false ? '未检测' : '未知'
}

function listLine(
  item: IntegrationManagementItemDto,
  detected: boolean | null,
): string {
  return [
    `${item.displayName} (${item.integrationId})`,
    packageLabel(item),
    enabledLabel(item),
    availabilityLabel(item.availability),
    `Detected：${detectedLabel(detected)}`,
    `Tool：${toolLabel(item)}`,
    ...(item.isNew ? ['新发现'] : []),
  ].join(' · ')
}

function printItem(
  item: IntegrationManagementItemDto,
  detected: boolean | null,
  print: (line: string) => void,
): void {
  print(`${item.displayName} (${item.integrationId})`)
  print(`  Detected：${detectedLabel(detected)}`)
  print(`  Tool Presence：${toolLabel(item)}`)
  if (item.tool?.executable) print(`  可执行文件：${item.tool.executable}`)
  else if (item.tool?.configRoot) print(`  配置目录：${item.tool.configRoot}`)
  else if (item.tool?.dataRoot) print(`  数据目录：${item.tool.dataRoot}`)
  print(`  Integration：${packageLabel(item)}`)
  print(`  Enabled：${enabledLabel(item)}`)
  print(`  Available：${availabilityLabel(item.availability)}`)
  if (item.capabilities.length) {
    print(`  能力：${item.capabilities.map(capability => {
      const authorization = capability.authorization === 'required'
        ? '，待授权'
        : capability.authorization === 'granted'
          ? '，已授权'
          : ''
      return `${capability.capability}=${capability.availability}${authorization}`
    }).join('；')}`)
  }
  if (item.packageState?.reason) print(`  包状态说明：${item.packageState.reason}`)
}

async function management(
  options: PluginCommandOptions,
): Promise<IntegrationManagementResponseDto> {
  return requestJson(
    options.apiUrl('/api/v1/integrations'),
    { method: 'GET' },
    options.fetchImpl ?? fetch,
  )
}

async function agentOverview(
  options: PluginCommandOptions,
): Promise<AgentOverviewResponseDto | null> {
  try {
    return await requestJson(
      options.apiUrl('/api/v1/agents'),
      { method: 'GET' },
      options.fetchImpl ?? fetch,
    )
  } catch {
    // Package management remains available even if the optional #70 overview
    // projection is temporarily unavailable. Detected must stay unknown rather
    // than being guessed from Tool Presence.
    return null
  }
}

async function readSnapshot(options: PluginCommandOptions): Promise<{
  management: IntegrationManagementResponseDto
  agents: AgentOverviewResponseDto | null
}> {
  const [managementResult, agents] = await Promise.all([
    management(options),
    agentOverview(options),
  ])
  return { management: managementResult, agents }
}

async function operation(
  action: 'install' | 'update' | 'remove',
  integrationId: string,
  options: PluginCommandOptions,
): Promise<IntegrationPackageOperationResponseDto> {
  const id = encodeURIComponent(integrationId)
  const pathname = action === 'remove'
    ? `/api/v1/integrations/${id}`
    : `/api/v1/integrations/${id}/${action}`
  return requestJson(
    options.apiUrl(pathname),
    { method: action === 'remove' ? 'DELETE' : 'POST' },
    options.fetchImpl ?? fetch,
  )
}

function printOperation(
  result: IntegrationPackageOperationResponseDto,
  print: (line: string) => void,
): void {
  const label = result.operation.kind === 'install'
    ? '安装'
    : result.operation.kind === 'update'
      ? '升级'
      : '卸载'
  if (result.operation.status === 'completed') {
    print(`Integration ${label}完成：${result.operation.integrationId}`)
    if (result.state.installedVersion) print(`版本：${result.state.installedVersion}`)
    if (result.state.restartRequired) print('需要重启 AgentLens 后完全生效。')
    return
  }
  print(`Integration ${label}失败：${result.operation.integrationId}`)
  print(result.operation.message ?? result.operation.errorCode ?? '未知错误')
}

export async function runPluginCommand(
  action: string,
  args: string[],
  json: boolean,
  options: PluginCommandOptions,
): Promise<number> {
  const print = options.print ?? console.log

  if (action === 'list') {
    if (args.length) throw new Error('用法：agent-lens plugin list [--json]')
    const snapshot = await readSnapshot(options)
    const items = snapshot.management.items.map(item => ({
      item,
      detected: detectedState(item, snapshot.agents),
    }))
    if (json) {
      print(JSON.stringify({
        items: items.map(({ item, detected }) => ({ ...item, detected })),
        meta: snapshot.management.meta,
      }, null, 2))
      return 0
    }
    if (!items.length) {
      print('暂无官方 Integration。')
      return 0
    }
    items.forEach(({ item, detected }) => print(listLine(item, detected)))
    return 0
  }

  if (action === 'status') {
    const integrationId = normalizePluginId(args[0])
    if (args.length > 1) throw new Error('用法：agent-lens plugin status <id> [--json]')
    const snapshot = await readSnapshot(options)
    const item = snapshot.management.items.find(candidate => candidate.integrationId === integrationId)
    if (!item) throw new Error(`未找到官方 Integration：${integrationId}`)
    const detected = detectedState(item, snapshot.agents)
    if (json) {
      print(JSON.stringify({
        item: { ...item, detected },
        meta: snapshot.management.meta,
      }, null, 2))
    } else {
      printItem(item, detected, print)
    }
    return 0
  }

  if (action === 'install' || action === 'update' || action === 'remove') {
    const integrationId = normalizePluginId(args[0])
    if (args.length > 1) throw new Error(`用法：agent-lens plugin ${action} <id> [--json]`)
    const result = await operation(action, integrationId, options)
    if (json) print(JSON.stringify(result, null, 2))
    else printOperation(result, print)
    return result.operation.status === 'completed' ? 0 : 1
  }

  throw new Error(
    `Unknown plugin action: ${action}\n\n`
      + '支持：list、status <id>、install <id>、update <id>、remove <id>',
  )
}

export const pluginCommandInternals = {
  normalizePluginId,
  apiErrorMessage,
  toolLabel,
  enabledLabel,
  availabilityLabel,
  packageLabel,
  detectedState,
  detectedLabel,
  listLine,
}
