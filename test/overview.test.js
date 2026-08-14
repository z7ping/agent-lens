const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const { insertTimeline } = require('../server/agent-lens-db');

const {
  buildOverview,
  discoverClaudeAssets,
  discoverCodexAssets,
  discoverHermesAssets,
  discoverPiAssets,
  inspectClaudeHooks,
  inspectCodexHooks,
  queryOverview,
  readOverviewInventory,
  refreshOverviewInventory,
} = require('../server/overview');

test('diagnoses Codex lifecycle hook coverage without exposing hook payloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-codex-hooks-'));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ command: 'node C:/agent-lens/hooks/codex-lifecycle.js' }] }],
      PreToolUse: [{ hooks: [{ command: 'node C:/agent-lens/hooks/prelog.js' }] }],
      Stop: [{ hooks: [{ command: 'node C:/other/observer.js' }] }],
    },
  }));
  fs.writeFileSync(path.join(root, 'config.toml'), '[hooks.state."one"]\ntrusted_hash = "sha256:test"\n');

  const diagnostics = inspectCodexHooks(root);
  assert.equal(diagnostics.status, 'partial');
  assert.equal(diagnostics.configured_count, 2);
  assert.equal(diagnostics.expected_count, 11);
  assert.equal(diagnostics.trust_record_count, 1);
  assert.ok(diagnostics.missing_events.includes('Stop'));
  assert.equal(JSON.stringify(diagnostics).includes('sha256:test'), false);
});

test('builds one overview card per tool with grouped capability assets', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        config_dir: 'C:/Users/test/.codex',
        version: '1.0.0',
        assets: [
          { name: 'superpowers:brainstorming', type: 'skill', status: 'enabled', path: 'C:/Users/test/.codex/skills/superpowers/brainstorming' },
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser' },
        ],
      },
      {
        tool: 'cursor',
        display_name: 'Cursor',
        config_dir: 'C:/Users/test/AppData/Roaming/Cursor/User',
        assets: [
          { name: 'browser', type: 'extension', status: 'enabled', path: 'C:/Users/test/.cursor/extensions/browser' },
        ],
      },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'superpowers:brainstorming', call_count: 8 },
      { source: 'codex', tool_name: 'browser', call_count: 3 },
      { source: 'cursor', tool_name: 'browser', call_count: 2 },
    ],
    priorityThreshold: 5,
  });

  assert.equal(overview.tools.length, 2);
  assert.equal(overview.tools[0].tool, 'codex');
  assert.equal(overview.tools[0].theme.accent, '#10b981');
  assert.equal(overview.tools[0].asset_groups.skill.count, 1);
  assert.equal(overview.tools[0].asset_groups.plugin.count, 1);
  assert.equal(overview.tools[0].links.github, 'https://github.com/openai/codex');
  assert.equal(overview.tools[0].order, 20);

  const brainstorming = overview.tools[0].assets.find(asset => asset.name === 'superpowers:brainstorming');
  assert.equal(brainstorming.call_count, 8);
  assert.equal(brainstorming.is_priority, true);
});

test('builds assembly paths and skill loading flow for tool diagnostics', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        config_dir: 'C:/Users/test/.codex',
        paths: [
          { role: '配置目录', path: 'C:/Users/test/.codex', status: 'exists' },
          { role: '配置文件', path: 'C:/Users/test/.codex/config.toml', status: 'configured' },
          { role: 'Hook 配置', path: 'C:/Users/test/.codex/hooks.json', status: 'missing' },
          { role: '用户 Skills', path: 'C:/Users/test/.codex/skills', status: 'exists' },
          { role: '插件缓存', path: 'C:/Users/test/.codex/plugins/cache', status: 'exists' },
          { role: '会话目录', path: 'C:/Users/test/.codex/sessions', status: 'exists' },
        ],
        assets: [
          { name: 'superpowers:brainstorming', type: 'skill', status: 'enabled', path: 'C:/Users/test/.codex/skills/superpowers/skills/brainstorming/SKILL.md' },
          { name: 'browser:control-in-app-browser', type: 'skill', status: 'enabled', path: 'C:/Users/test/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/control-in-app-browser/SKILL.md' },
          { name: 'node_repl', type: 'mcp', status: 'configured', path: 'C:/Users/test/.codex/config.toml' },
        ],
      },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'superpowers:brainstorming', call_count: 4 },
      { source: 'codex', tool_name: 'browser:control-in-app-browser', call_count: 0 },
    ],
  });

  const codex = overview.tools[0];
  assert.deepEqual(codex.paths.map(item => item.role), ['配置目录', '配置文件', 'Hook 配置', '用户 Skills', '插件缓存', '会话目录']);
  assert.equal(codex.paths.find(item => item.role === 'Hook 配置').status, 'missing');

  const skillFlow = codex.load_flow.find(flow => flow.type === 'skill');
  assert.equal(skillFlow.installed_count, 2);
  assert.equal(skillFlow.used_count, 1);
  assert.equal(skillFlow.sources.local.count, 1);
  assert.equal(skillFlow.sources.plugin.count, 1);
});

test('builds configuration evidence without collapsing static discovery and invocation', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        config_dir: 'C:/Users/test/.codex',
        paths: [
          { role: '配置目录', path: 'C:/Users/test/.codex', status: 'exists' },
          { role: 'Hook 配置', path: 'C:/Users/test/.codex/hooks.json', status: 'complete', description: 'AgentLens Hook 11/11' },
        ],
        assets: [
          { name: 'github', type: 'mcp', status: 'configured', path: 'C:/Users/test/.codex/config.toml' },
          { name: 'brainstorming', type: 'skill', status: 'enabled', path: 'C:/Users/test/.codex/skills/brainstorming/SKILL.md' },
        ],
      },
    ],
    usageRows: [
      {
        source: 'codex',
        tool_name: 'github',
        call_count: 2,
        last_observed_at: '2026-08-14T01:00:00.000Z',
        capture_methods: 'runtime_hook,native_log',
      },
    ],
    sourceEvidenceRows: [
      { source: 'codex', capture_method: 'runtime_hook', event_count: 3, session_count: 1, last_observed_at: '2026-08-14T01:00:00.000Z' },
      { source: 'codex', capture_method: 'native_log', event_count: 8, session_count: 1, last_observed_at: '2026-08-14T01:05:00.000Z' },
    ],
    priorityThreshold: 1,
  });

  const codex = overview.tools[0];
  const github = codex.assets.find(asset => asset.name === 'github');

  assert.ok(Array.isArray(codex.evidence));
  assert.ok(Array.isArray(codex.config_chain));
  assert.equal(codex.runtime_status.hook_status, 'complete');
  assert.equal(codex.runtime_status.last_event_at, '2026-08-14T01:05:00.000Z');
  assert.equal(codex.reconciliation.status, 'matched');
  assert.equal(codex.reconciliation.mode, 'runtime_and_history');
  assert.equal(codex.reconciliation.runtime_events, 3);
  assert.equal(codex.reconciliation.history_events, 8);
  assert.ok(codex.capability_matrix.some(item => item.capability === 'configuration'));

  assert.equal(github.evidence.length, 2);
  assert.deepEqual(github.evidence.map(item => item.status), ['disk_discovered', 'invoked']);
  assert.equal(github.evidence[0].evidence_type, 'static_scan');
  assert.equal(github.evidence[1].evidence_type, 'runtime_hook');
  assert.equal(github.evidence[1].visibility, 'invoked');
  assert.equal(github.evidence[1].observed_at, '2026-08-14T01:00:00.000Z');
  assert.match(github.evidence[0].missing_reason, /不能证明本次运行已加载/);
});

test('marks sources as history mode when runtime events are absent', () => {
  const overview = buildOverview({
    inventory: [{
      tool: 'pi',
      display_name: 'Pi',
      config_dir: 'C:/Users/test/.pi/agent',
      assets: [],
    }],
    sourceEvidenceRows: [
      { source: 'pi', capture_method: 'native_log', event_count: 42, session_count: 2, last_observed_at: '2026-08-14T02:00:00.000Z' },
    ],
  });

  const pi = overview.tools[0];
  assert.equal(pi.reconciliation.status, 'degraded');
  assert.equal(pi.reconciliation.mode, 'history_only');
  assert.equal(pi.reconciliation.history_events, 42);
  assert.equal(pi.reconciliation.runtime_events, 0);
  assert.match(pi.reconciliation.gap_reason, /历史模式/);
  assert.match(pi.runtime_status.degradation_reason, /原生 JSONL/);
});

test('summarizes Pi runtime/native tool reconciliation by stable call id', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-14T00:00:00.000Z',
    inventory: [{
      tool: 'pi',
      display_name: 'Pi',
      description: 'Pi coding agent',
      version: '0.83.0',
      status: 'detected',
      config_dir: 'C:/Users/test/.pi/agent',
      assets: [],
    }],
  });

  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:01.000Z', role: 'tool_use', event_type: 'tool_use', call_id: 'matched', tool_name: 'bash', capture_method: 'runtime_hook', source_sequence: 1 }, db);
  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:02.000Z', role: 'tool_result', event_type: 'tool_result', call_id: 'matched', tool_name: 'bash', success: 1, capture_method: 'native_log', source_sequence: 2 }, db);
  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:03.000Z', role: 'tool_use', event_type: 'tool_use', call_id: 'runtime-only', tool_name: 'read', capture_method: 'runtime_hook', source_sequence: 3 }, db);
  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:04.000Z', role: 'tool_result', event_type: 'tool_result', call_id: 'history-only', tool_name: 'write', success: 1, capture_method: 'native_log', source_sequence: 4 }, db);
  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:05.000Z', role: 'tool_result', event_type: 'tool_result', call_id: 'conflict', tool_name: 'edit', success: 1, capture_method: 'runtime_hook', source_sequence: 5 }, db);
  insertTimeline({ source: 'pi', session_id: 's1', timestamp: '2026-08-14T00:00:06.000Z', role: 'tool_error', event_type: 'tool_error', call_id: 'conflict', tool_name: 'edit', success: 0, capture_method: 'native_log', source_sequence: 6 }, db);

  const overview = queryOverview(db);
  const pi = overview.tools.find(tool => tool.tool === 'pi');
  const toolCalls = pi.reconciliation.details.tool_calls;

  assert.equal(pi.reconciliation.status, 'conflict');
  assert.equal(toolCalls.tool_call_count, 4);
  assert.equal(toolCalls.matched_calls, 1);
  assert.equal(toolCalls.runtime_only_calls, 1);
  assert.equal(toolCalls.history_only_calls, 1);
  assert.equal(toolCalls.conflict_calls, 1);
  assert.ok(toolCalls.samples.some(item => item.call_id === 'matched' && item.status === 'matched'));
  db.close();
});

test('keeps tool links and order when reading overview from database snapshot', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-07T00:00:00.000Z',
    inventory: [
      {
        tool: 'pi',
        display_name: 'Pi',
        description: 'Pi coding agent',
        version: '1.2.3',
        status: 'detected',
        config_dir: 'C:/Users/test/.pi/agent',
        theme: { accent: '#eab308', surface: '#fefce8' },
        assets: [],
      },
    ],
  });

  const overview = buildOverview({ inventory: readOverviewInventory(db), usageRows: [] });
  const pi = overview.tools[0];

  assert.equal(pi.order, 10);
  assert.equal(pi.links.homepage, 'https://pi.dev');
  assert.equal(pi.links.docs, 'https://pi.dev/docs/latest');
  assert.equal(pi.links.github, 'https://github.com/earendil-works/pi');
});

test('discovers Codex recursive skills, plugins and configured MCP paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-codex-'));
  const codexDir = path.join(tmp, '.codex');
  const skillDir = path.join(codexDir, 'skills', 'superpowers', 'skills', 'brainstorming');
  const pluginDir = path.join(codexDir, 'plugins', 'cache', 'openai-bundled', 'browser', '1.0.0');
  const pluginSkillDir = path.join(pluginDir, 'skills', 'control-browser');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(pluginSkillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: brainstorming\n---\n', 'utf-8');
  fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), '---\nname: control-browser\n---\n', 'utf-8');
  fs.writeFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'browser',
    description: 'Browser control',
  }), 'utf-8');
  fs.writeFileSync(path.join(codexDir, 'config.toml'), `
model = "gpt-5"
sandbox_mode = "workspace-write"

[mcp_servers.node_repl]
command = "node_repl"

[plugins."browser@openai-bundled"]
enabled = true
`, 'utf-8');

  const assets = discoverCodexAssets(codexDir);
  const namesByType = new Map(assets.map(asset => [`${asset.type}:${asset.name}`, asset]));

  assert.ok(namesByType.has('skill:superpowers:skills:brainstorming'));
  assert.ok(namesByType.has('skill:openai-bundled:browser:1.0.0:skills:control-browser'));
  assert.equal(namesByType.get('plugin:browser').path, path.join(pluginDir, '.codex-plugin', 'plugin.json'));
  assert.equal(namesByType.get('mcp:node_repl').path, path.join(codexDir, 'config.toml'));
  assert.equal(namesByType.get('plugin:browser@openai-bundled').path, path.join(codexDir, 'config.toml'));
  assert.equal(namesByType.get('builtin:模型:gpt-5').description, 'Codex 运行边界配置');
  assert.equal(namesByType.get('builtin:沙箱模式:workspace-write').path, path.join(codexDir, 'config.toml'));
});

test('discovers Claude Code settings, global config, commands and runtime boundary assets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-claude-'));
  const homeDir = path.join(tmp, 'home');
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'reviewer'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'commands', 'git'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'reviewer', 'SKILL.md'), '---\nname: reviewer\n---\n', 'utf-8');
  fs.writeFileSync(path.join(claudeDir, 'commands', 'git', 'status.md'), '# status\n', 'utf-8');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    model: 'claude-opus-test',
    permissionMode: 'acceptEdits',
    hooks: {
      PreToolUse: [{ hooks: [{ command: 'node C:/agent-lens/hooks/prelog.js' }] }],
    },
    mcpServers: {
      filesystem: { command: 'fs-mcp' },
    },
  }), 'utf-8');
  fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
    mcp_servers: {
      github: { command: 'github-mcp' },
    },
  }), 'utf-8');

  const assets = discoverClaudeAssets(claudeDir, { homeDir });
  const namesByType = new Map(assets.map(asset => [`${asset.type}:${asset.name}`, asset]));

  assert.equal(namesByType.get('skill:reviewer').path, path.join(claudeDir, 'skills', 'reviewer', 'SKILL.md'));
  assert.equal(namesByType.get('builtin:git:status').path, path.join(claudeDir, 'commands', 'git', 'status.md'));
  assert.equal(namesByType.get('mcp:filesystem').path, path.join(claudeDir, 'settings.json'));
  assert.equal(namesByType.get('mcp:github').path, path.join(homeDir, '.claude.json'));
  assert.equal(namesByType.get('builtin:模型:claude-opus-test').description, 'Claude Code 运行边界配置');
  assert.equal(namesByType.get('builtin:权限模式:acceptEdits').path, path.join(claudeDir, 'settings.json'));
  assert.deepEqual(inspectClaudeHooks(claudeDir).missing_events, ['PostToolUse']);
});

test('orders overview tools by product default order in API payload', () => {
  const overview = buildOverview({
    inventory: [
      { tool: 'cursor', display_name: 'Cursor', assets: [] },
      { tool: 'codex', display_name: 'Codex', assets: [] },
      { tool: 'pi', display_name: 'Pi', assets: [] },
    ],
    usageRows: [],
  });

  assert.deepEqual(overview.tools.map(tool => tool.tool), ['pi', 'codex', 'cursor']);
});

test('discovers Hermes skills, plugins, MCP servers and toolsets across config roots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-hermes-'));
  const homeDir = path.join(tmp, 'home');
  const runtimeDir = path.join(homeDir, 'AppData', 'Local', 'hermes');
  const userConfigDir = path.join(homeDir, '.hermes');
  const skillDir = path.join(runtimeDir, 'skills', 'software-development', 'test-driven-development');
  const pluginDir = path.join(runtimeDir, 'plugins', 'clawd-on-desk');
  const mcpDir = path.join(userConfigDir, 'mcp-servers', 'toolbox');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(mcpDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-driven-development\n---\n', 'utf-8');
  fs.writeFileSync(path.join(pluginDir, 'plugin.yaml'), 'name: clawd-on-desk\n', 'utf-8');
  fs.writeFileSync(path.join(runtimeDir, 'config.yaml'), `
model: hermes-model-test
permission_mode: suggest
mcp_servers:
  codegraph:
    command: codegraph
toolsets:
  - hermes-cli
platform_toolsets:
  cli:
    - mcp-codegraph
`, 'utf-8');

  const assets = discoverHermesAssets(runtimeDir, { homeDir });
  const namesByType = new Map(assets.map(asset => [`${asset.type}:${asset.name}`, asset]));

  assert.equal(namesByType.get('skill:software-development:test-driven-development').path, path.join(skillDir, 'SKILL.md'));
  assert.equal(namesByType.get('plugin:clawd-on-desk').path, pluginDir);
  assert.equal(namesByType.get('mcp:codegraph').path, path.join(runtimeDir, 'config.yaml'));
  assert.equal(namesByType.get('mcp:toolbox').path, mcpDir);
  assert.equal(namesByType.get('builtin:hermes-cli').path, path.join(runtimeDir, 'config.yaml'));
  assert.equal(namesByType.get('builtin:mcp-codegraph').path, path.join(runtimeDir, 'config.yaml'));
  assert.equal(namesByType.get('builtin:模型:hermes-model-test').description, 'Hermes 运行边界配置');
  assert.equal(namesByType.get('builtin:权限模式:suggest').path, path.join(runtimeDir, 'config.yaml'));
});

test('builds a capability matrix for high-frequency assets across tools', () => {
  const overview = buildOverview({
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        assets: [
          { name: 'github', type: 'mcp', status: 'configured' },
          { name: 'superpowers:brainstorming', type: 'skill', status: 'enabled' },
        ],
      },
      {
        tool: 'claude-code',
        display_name: 'Claude Code',
        assets: [
          { name: 'github', type: 'mcp', status: 'configured' },
        ],
      },
      {
        tool: 'cursor',
        display_name: 'Cursor',
        assets: [],
      },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'github', call_count: 10 },
      { source: 'codex', tool_name: 'superpowers:brainstorming', call_count: 9 },
    ],
    priorityThreshold: 5,
  });

  assert.deepEqual(overview.priority_assets.map(asset => asset.name), ['github', 'superpowers:brainstorming']);

  const github = overview.capability_matrix.find(row => row.name === 'github');
  assert.equal(github.coverage.codex.status, '已有');
  assert.equal(github.coverage['claude-code'].status, '已有');
  assert.equal(github.coverage.cursor.status, '缺失');

  const brainstorming = overview.capability_matrix.find(row => row.name === 'superpowers:brainstorming');
  assert.equal(brainstorming.coverage.codex.status, '已有');
  assert.equal(brainstorming.coverage['claude-code'].status, '缺失');
});

test('adds frequently used timeline-only assets to the owning tool card', () => {
  const overview = buildOverview({
    inventory: [
      { tool: 'codex', display_name: 'Codex', assets: [] },
      { tool: 'cursor', display_name: 'Cursor', assets: [] },
    ],
    usageRows: [
      { source: 'codex', tool_name: 'Bash', call_count: 12 },
      { source: 'cursor', tool_name: 'Bash', call_count: 2 },
    ],
    priorityThreshold: 5,
  });

  const codex = overview.tools.find(tool => tool.tool === 'codex');
  const bash = codex.assets.find(asset => asset.name === 'Bash');

  assert.equal(bash.type, 'builtin');
  assert.equal(bash.status, 'observed');
  assert.equal(bash.call_count, 12);
  assert.equal(bash.is_priority, true);

  const row = overview.capability_matrix.find(item => item.name === 'Bash');
  assert.equal(row.coverage.codex.status, '已有');
  assert.equal(row.coverage.cursor.status, '已有');
});

test('discovers Pi plugins from agent npm dependencies and extensions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-'));
  const piDir = path.join(tmp, '.pi');
  const npmDir = path.join(piDir, 'agent', 'npm');
  const modulesDir = path.join(npmDir, 'node_modules');
  fs.mkdirSync(path.join(modulesDir, 'pi-add-dir'), { recursive: true });
  fs.mkdirSync(path.join(modulesDir, '@vendor', 'pi-theme'), { recursive: true });
  fs.mkdirSync(path.join(modulesDir, 'pi-add-dir', 'skills', 'pi-add-dir-skill'), { recursive: true });
  fs.mkdirSync(path.join(piDir, 'agent', 'extensions', 'clawd-on-desk'), { recursive: true });
  fs.mkdirSync(path.join(piDir, 'agent', 'projects-memory', 'agent-lens', 'skills', 'project-memory-skill'), { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'package.json'), JSON.stringify({
    dependencies: {
      'pi-add-dir': '^1.0.0',
      '@vendor/pi-theme': '^2.0.0',
      lodash: '^4.0.0',
    },
  }));
  fs.writeFileSync(path.join(modulesDir, 'pi-add-dir', 'package.json'), JSON.stringify({
    name: 'pi-add-dir',
    version: '1.0.0',
    description: 'Add directories to Pi',
  }));
  fs.writeFileSync(path.join(modulesDir, '@vendor', 'pi-theme', 'package.json'), JSON.stringify({
    name: '@vendor/pi-theme',
    version: '2.0.0',
    keywords: ['pi-extension'],
  }));

  const assets = discoverPiAssets(piDir);
  const plugins = assets.filter(asset => asset.type === 'plugin').map(asset => asset.name).sort();
  const extensions = assets.filter(asset => asset.type === 'extension').map(asset => asset.name);
  const skills = assets.filter(asset => asset.type === 'skill').map(asset => asset.name).sort();

  assert.deepEqual(plugins, ['@vendor/pi-theme', 'pi-add-dir']);
  assert.deepEqual(extensions, ['clawd-on-desk']);
  assert.deepEqual(skills, ['pi-add-dir-skill', 'project-memory-skill']);
});

test('discovers Pi assets when the agent directory is the configured root', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-agent-'));
  const npmDir = path.join(agentDir, 'npm');
  const modulesDir = path.join(npmDir, 'node_modules');
  fs.mkdirSync(path.join(modulesDir, 'pi-cache-optimizer', 'skills', 'cache-skill'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'extensions', 'desktop-shell'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'skills', 'user-skill'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'pi-hermes-memory', 'skills', 'memory-skill'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'projects-memory', 'demo', 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'package.json'), JSON.stringify({
    dependencies: {
      'pi-cache-optimizer': '^1.0.0',
    },
  }));
  fs.writeFileSync(path.join(modulesDir, 'pi-cache-optimizer', 'package.json'), JSON.stringify({
    name: 'pi-cache-optimizer',
    version: '1.0.0',
  }));

  const assets = discoverPiAssets(agentDir);
  const plugins = assets.filter(asset => asset.type === 'plugin').map(asset => asset.name);
  const extensions = assets.filter(asset => asset.type === 'extension').map(asset => asset.name);
  const skills = assets.filter(asset => asset.type === 'skill').map(asset => asset.name).sort();

  assert.deepEqual(plugins, ['pi-cache-optimizer']);
  assert.deepEqual(extensions, ['desktop-shell']);
  assert.deepEqual(skills, ['cache-skill', 'demo-skill', 'memory-skill', 'user-skill']);
});

test('discovers Pi assets from default candidate environment paths', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-env-'));
  const npmDir = path.join(agentDir, 'npm');
  const modulesDir = path.join(npmDir, 'node_modules');
  fs.mkdirSync(path.join(modulesDir, 'pi-env-plugin'), { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'package.json'), JSON.stringify({
    dependencies: {
      'pi-env-plugin': '^1.0.0',
    },
  }));
  fs.writeFileSync(path.join(modulesDir, 'pi-env-plugin', 'package.json'), JSON.stringify({
    name: 'pi-env-plugin',
    version: '1.0.0',
  }));

  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const assets = discoverPiAssets('');
    assert.ok(assets.some(asset => asset.type === 'plugin' && asset.name === 'pi-env-plugin'));
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
});

test('discovers Pi configured skills and package-declared resources', () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-resources-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-pi-home-'));
  const externalSkillDir = path.join(homeDir, '.agents', 'skills', 'shared-skill');
  const npmDir = path.join(agentDir, 'npm');
  const modulesDir = path.join(npmDir, 'node_modules');
  const packageDir = path.join(modulesDir, 'pi-resource-pack');
  const settingsPackageDir = path.join(modulesDir, 'pi-settings-pack');
  const explicitExtensionFile = path.join(agentDir, 'external-extensions', 'configured-extension', 'index.ts');

  fs.mkdirSync(path.join(packageDir, 'custom-skills', 'pack-skill'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'extensions', 'pack-extension'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'extensions', 'file-extension.ts'), 'export default function () {}');
  fs.writeFileSync(path.join(packageDir, 'custom-skills', 'pack-skill', 'SKILL.md'), '---\nname: pack-skill\ndescription: pack skill\n---\n');
  fs.writeFileSync(path.join(agentDir, 'skills', 'root-skill.md'), '---\nname: root-skill\ndescription: root skill\n---\n');
  fs.mkdirSync(path.join(packageDir, 'custom-extensions', 'declared-extension'), { recursive: true });
  fs.mkdirSync(path.join(settingsPackageDir, 'skills', 'settings-pack-skill'), { recursive: true });
  fs.mkdirSync(path.dirname(explicitExtensionFile), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'explicit-skills', 'configured-skill'), { recursive: true });
  fs.mkdirSync(externalSkillDir, { recursive: true });
  fs.writeFileSync(explicitExtensionFile, 'export default function () {}');
  fs.writeFileSync(path.join(npmDir, 'package.json'), JSON.stringify({
    dependencies: {
      'pi-resource-pack': '^1.0.0',
    },
  }));
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'pi-resource-pack',
    version: '1.0.0',
    pi: {
      skills: ['./custom-skills'],
      extensions: ['./custom-extensions'],
    },
  }));
  fs.writeFileSync(path.join(settingsPackageDir, 'package.json'), JSON.stringify({
    name: 'pi-settings-pack',
    version: '1.0.0',
  }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    model: 'pi-model-pro',
    sandboxMode: 'workspace-write',
    mcpServers: {
      github: { command: 'github-mcp' },
    },
    skills: ['./explicit-skills'],
    extensions: ['+external-extensions/configured-extension/index.ts'],
    packages: ['npm:pi-settings-pack'],
  }));

  const assets = discoverPiAssets(agentDir, { homeDir });
  const namesByType = new Map(assets.map(asset => [`${asset.type}:${asset.name}`, asset]));
  const skills = assets.filter(asset => asset.type === 'skill').map(asset => asset.name).sort();
  const extensions = assets.filter(asset => asset.type === 'extension').map(asset => asset.name).sort();

  assert.equal(namesByType.get('mcp:github').path, path.join(agentDir, 'settings.json'));
  assert.equal(namesByType.get('builtin:模型:pi-model-pro').description, 'Pi 运行边界配置');
  assert.equal(namesByType.get('builtin:沙箱模式:workspace-write').path, path.join(agentDir, 'settings.json'));
  assert.deepEqual(skills, ['configured-skill', 'pack-skill', 'root-skill', 'settings-pack-skill', 'shared-skill']);
  assert.deepEqual(extensions, ['configured-extension', 'declared-extension', 'file-extension', 'pack-extension']);
});

test('persists stable overview inventory in the AgentLens database', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-07T00:00:00.000Z',
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        version: '1.2.3',
        status: 'detected',
        config_dir: 'C:/Users/test/.codex',
        theme: { accent: '#10b981', surface: '#ecfdf5' },
        assets: [
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser', description: 'Browser control' },
        ],
      },
    ],
  });

  const inventory = readOverviewInventory(db);

  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].tool, 'codex');
  assert.equal(inventory[0].version, '1.2.3');
  assert.equal(inventory[0].theme.accent, '#10b981');
  assert.equal(inventory[0].assets.length, 1);
  assert.equal(inventory[0].assets[0].name, 'browser');

  const run = db.prepare('SELECT status, tool_count, asset_count FROM overview_scan_runs ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual(run, { status: 'success', tool_count: 1, asset_count: 1 });
});

test('配置采集关闭时不持久化配置路径和能力资产', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));
  refreshOverviewInventory(db, {
    env: { AGENT_LENS_CONFIG_CAPTURE: 'off' },
    inventory: [{
      tool: 'codex', display_name: 'Codex', status: 'detected',
      config_dir: 'C:/Users/test/.codex',
      assets: [{ name: 'private-mcp', type: 'mcp', path: 'C:/Users/test/.codex/config.toml' }],
    }],
  });

  const inventory = readOverviewInventory(db);
  assert.equal(inventory[0].status, 'capture_off');
  assert.equal(inventory[0].config_dir, '');
  assert.deepEqual(inventory[0].assets, []);
  db.close();
});

test('queryOverview reads cached inventory from database and merges timeline usage', () => {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'server', 'schema.sql'), 'utf-8'));

  refreshOverviewInventory(db, {
    now: '2026-08-07T00:00:00.000Z',
    inventory: [
      {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI coding agent',
        version: '1.2.3',
        status: 'detected',
        config_dir: 'C:/Users/test/.codex',
        assets: [
          { name: 'browser', type: 'plugin', status: 'installed', path: 'C:/Users/test/.codex/plugins/browser' },
        ],
      },
    ],
  });
  insertTimeline({ source: 'codex', session_id: 's1', timestamp: '2026-08-07T00:00:01.000Z', role: 'tool_result', tool_name: 'browser', success: 1, source_sequence: 1 }, db);
  insertTimeline({ source: 'codex', session_id: 's2', timestamp: '2026-08-07T00:00:02.000Z', role: 'tool_result', tool_name: 'browser', success: 1, source_sequence: 1 }, db);

  const overview = queryOverview(db, { priorityThreshold: 2 });
  const browser = overview.tools[0].assets.find(asset => asset.name === 'browser');

  assert.equal(overview.tools[0].version, '1.2.3');
  assert.equal(browser.call_count, 2);
  assert.equal(browser.is_priority, true);
  assert.equal(overview.capability_matrix[0].name, 'browser');

  const configHidden = queryOverview(db, { env: { AGENT_LENS_CONFIG_CAPTURE: 'off' } });
  const hiddenCodex = configHidden.tools.find(tool => tool.tool === 'codex');
  assert.equal(hiddenCodex.config_dir, '');
  assert.equal(hiddenCodex.assets.find(asset => asset.name === 'browser').path, '');
});
