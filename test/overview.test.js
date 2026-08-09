const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

const {
  buildOverview,
  discoverCodexAssets,
  discoverHermesAssets,
  discoverPiAssets,
  readOverviewInventory,
  refreshOverviewInventory,
} = require('../server/overview');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-codex-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-hermes-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-'));
  const piDir = path.join(tmp, '.pi');
  const npmDir = path.join(piDir, 'agent', 'npm');
  const modulesDir = path.join(npmDir, 'node_modules');
  fs.mkdirSync(path.join(modulesDir, 'pi-add-dir'), { recursive: true });
  fs.mkdirSync(path.join(modulesDir, '@vendor', 'pi-theme'), { recursive: true });
  fs.mkdirSync(path.join(modulesDir, 'pi-add-dir', 'skills', 'pi-add-dir-skill'), { recursive: true });
  fs.mkdirSync(path.join(piDir, 'agent', 'extensions', 'clawd-on-desk'), { recursive: true });
  fs.mkdirSync(path.join(piDir, 'agent', 'projects-memory', 'agent-trace', 'skills', 'project-memory-skill'), { recursive: true });
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
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-agent-'));
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
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-env-'));
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
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-resources-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-trace-pi-home-'));
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
    skills: ['./explicit-skills'],
    extensions: ['+external-extensions/configured-extension/index.ts'],
    packages: ['npm:pi-settings-pack'],
  }));

  const assets = discoverPiAssets(agentDir, { homeDir });
  const skills = assets.filter(asset => asset.type === 'skill').map(asset => asset.name).sort();
  const extensions = assets.filter(asset => asset.type === 'extension').map(asset => asset.name).sort();

  assert.deepEqual(skills, ['configured-skill', 'pack-skill', 'root-skill', 'settings-pack-skill', 'shared-skill']);
  assert.deepEqual(extensions, ['configured-extension', 'declared-extension', 'file-extension', 'pack-extension']);
});

test('persists stable overview inventory in the agent trace database', () => {
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
  db.prepare(`
    INSERT INTO timeline (source, session_id, timestamp, role, tool_name, success)
    VALUES ('codex', 's1', '2026-08-07T00:00:01.000Z', 'tool_result', 'browser', 1)
  `).run();
  db.prepare(`
    INSERT INTO timeline (source, session_id, timestamp, role, tool_name, success)
    VALUES ('codex', 's2', '2026-08-07T00:00:02.000Z', 'tool_result', 'browser', 1)
  `).run();

  const { queryOverview } = require('../server/overview');
  const overview = queryOverview(db, { priorityThreshold: 2 });
  const browser = overview.tools[0].assets.find(asset => asset.name === 'browser');

  assert.equal(overview.tools[0].version, '1.2.3');
  assert.equal(browser.call_count, 2);
  assert.equal(browser.is_priority, true);
  assert.equal(overview.capability_matrix[0].name, 'browser');
});
