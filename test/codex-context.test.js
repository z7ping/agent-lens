const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverCodexInstructionFiles } = require('../server/codex-context');

test('discovers Codex instruction files in documented precedence order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-codex-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'home', '.codex');
  const project = path.join(root, 'project');
  const nested = path.join(project, 'packages', 'app');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'global');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'project_doc_fallback_filenames = ["TEAM.md"]\nproject_doc_max_bytes = 32768\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'root');
  fs.writeFileSync(path.join(project, 'packages', 'TEAM.md'), 'package');
  fs.writeFileSync(path.join(nested, 'AGENTS.override.md'), 'nested');

  const entries = discoverCodexInstructionFiles(nested, { codexHome, projectRoot: project, env: {} });
  assert.deepEqual(entries.map(entry => entry.content), ['global', 'root', 'package', 'nested']);
  assert.deepEqual(entries.map(entry => entry.scope), ['global', 'project', 'project', 'project']);
  assert.deepEqual(entries.map(entry => entry.precedence), [0, 1, 2, 3]);
});

test('does not discover or persist context paths when config capture is off', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-codex-context-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'private instructions');
  const entries = discoverCodexInstructionFiles(root, {
    codexHome: path.join(root, '.codex'),
    projectRoot: root,
    env: { AGENT_LENS_CONFIG_CAPTURE: 'off' },
  });
  assert.deepEqual(entries, []);
});
