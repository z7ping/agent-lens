const SOURCE_CAPABILITIES = {
  codex: {
    label: 'Codex',
    completeness: 'partial',
    summary: '历史对话和工具事件可导入；完整生命周期将在 v0.5 接入。',
    capabilities: {
      session: ['partial', 'native_log', '可读取会话元数据，实时 Session 生命周期尚未接入'],
      prompt: ['partial', 'native_log', '可读取历史用户消息，提交前原始提示词尚未接入'],
      conversation: ['supported', 'native_log', '可读取历史用户与助手消息'],
      tool_lifecycle: ['supported', 'runtime_hook', 'Hook 与历史日志均区分调用和结果'],
      compact: ['unavailable', 'native_log', 'v0.5 接入'],
      subagent: ['unavailable', 'native_log', 'v0.5 接入；来源可能不提供 transcript'],
      stop: ['unavailable', 'runtime_hook', 'v0.5 接入'],
      configuration: ['partial', 'static_scan', '可静态发现，不能证明进入本次运行'],
    },
  },
  'claude-code': {
    label: 'Claude Code CLI',
    completeness: 'partial',
    summary: '历史对话与工具生命周期可观察，部分上下文和生命周期事件不可用。',
    capabilities: {
      session: ['partial', 'native_log', '可从会话文件重建摘要'],
      prompt: ['supported', 'native_log', '可读取历史用户消息'],
      conversation: ['supported', 'native_log', '可读取用户与助手消息'],
      tool_lifecycle: ['supported', 'runtime_hook', 'Hook 与历史日志均区分调用和结果'],
      compact: ['partial', 'native_log', '来源存在记录时可观察'],
      subagent: ['partial', 'native_log', '仅在来源提供相关记录时可观察'],
      stop: ['unavailable', 'native_log', '当前未采集独立停止事件'],
      configuration: ['partial', 'static_scan', '可静态发现，不能证明进入本次运行'],
    },
  },
  hermes: {
    label: 'Hermes',
    completeness: 'partial',
    summary: '本地数据库包含对话和工具结果，独立调用时点与完整生命周期有限。',
    capabilities: {
      session: ['supported', 'local_database', '可读取本地 Session'],
      prompt: ['supported', 'local_database', '可读取用户消息'],
      conversation: ['supported', 'local_database', '可读取对话'],
      tool_lifecycle: ['partial', 'local_database', '结果可确认，调用事件可能由同一原生记录拆分'],
      compact: ['unavailable', 'local_database', '来源未提供'],
      subagent: ['unavailable', 'local_database', '来源未提供可靠父子关系'],
      stop: ['unavailable', 'local_database', '来源未提供独立事件'],
      configuration: ['partial', 'static_scan', '仅静态发现'],
    },
  },
  opencode: {
    label: 'OpenCode', completeness: 'partial', summary: '本地数据库包含对话和工具记录，部分生命周期不可观察。',
    capabilities: {
      session: ['supported', 'local_database', '可读取本地 Session'], prompt: ['supported', 'local_database', '可读取用户消息'], conversation: ['supported', 'local_database', '可读取对话'], tool_lifecycle: ['partial', 'local_database', '按来源记录拆分调用与结果'], compact: ['unavailable', 'local_database', '来源未提供'], subagent: ['unavailable', 'local_database', '来源未提供可靠关系'], stop: ['unavailable', 'local_database', '来源未提供'], configuration: ['partial', 'static_scan', '仅静态发现'],
    },
  },
  pi: {
    label: 'Pi', completeness: 'partial', summary: '会话文件包含对话和工具结果，独立生命周期信息有限。',
    capabilities: {
      session: ['supported', 'native_log', '可读取会话文件'], prompt: ['supported', 'native_log', '可读取用户消息'], conversation: ['supported', 'native_log', '可读取对话'], tool_lifecycle: ['partial', 'native_log', '按来源记录拆分调用与结果'], compact: ['unavailable', 'native_log', '来源未提供'], subagent: ['unavailable', 'native_log', '来源未提供可靠关系'], stop: ['unavailable', 'native_log', '来源未提供'], configuration: ['partial', 'static_scan', '仅静态发现'],
    },
  },
  cursor: {
    label: 'Cursor', completeness: 'limited', summary: '当前只有实时工具 Hook，缺少对话与 Session 全生命周期。',
    capabilities: {
      session: ['partial', 'runtime_hook', '仅使用 Hook 中的 Session 标识'], prompt: ['unavailable', 'runtime_hook', '当前 Hook 未提供'], conversation: ['unavailable', 'runtime_hook', '当前 Hook 未提供'], tool_lifecycle: ['supported', 'runtime_hook', '区分调用和结果'], compact: ['unavailable', 'runtime_hook', '当前 Hook 未提供'], subagent: ['unavailable', 'runtime_hook', '当前 Hook 未提供'], stop: ['unavailable', 'runtime_hook', '当前 Hook 未提供'], configuration: ['partial', 'static_scan', '仅静态发现'],
    },
  },
  openclaw: {
    label: 'OpenClaw', completeness: 'unavailable', summary: '适配器尚未实现。',
    capabilities: {},
  },
};

const CAPABILITY_LABELS = {
  session: 'Session', prompt: '用户提示词', conversation: '对话', tool_lifecycle: '工具生命周期',
  compact: 'Compact', subagent: '子 Agent', stop: '停止事件', configuration: '配置与能力',
};

function getCapabilityMatrix() {
  const sources = Object.entries(SOURCE_CAPABILITIES).map(([source, definition]) => ({
    source,
    label: definition.label,
    completeness: definition.completeness,
    summary: definition.summary,
    capabilities: Object.entries(definition.capabilities).map(([capability, values]) => ({
      capability,
      label: CAPABILITY_LABELS[capability] || capability,
      status: values[0],
      capture_method: values[1],
      reason: values[2],
    })),
  }));
  const { getCapturePolicy } = require('./privacy');
  return { generated_at: new Date().toISOString(), capture_policy: getCapturePolicy(), sources };
}

function getSourceCapability(source) {
  return getCapabilityMatrix().sources.find(item => item.source === source) || null;
}

module.exports = { SOURCE_CAPABILITIES, CAPABILITY_LABELS, getCapabilityMatrix, getSourceCapability };
