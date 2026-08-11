const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatNodeHookCommand,
  removeAgentLensHooks,
  uninstallHooksFromFile,
  updateCodexTrustHash,
} = require('../server/install-hooks');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-hooks-test-'));
}

test('quotes hook script paths so user directories may contain spaces', () => {
  assert.equal(
    formatNodeHookCommand('C:/Users/Test User/.agent-lens/app/hooks/prelog.js'),
    'node "C:/Users/Test User/.agent-lens/app/hooks/prelog.js"',
  );
});

test('removes AgentLens hooks while preserving unrelated tool hooks', () => {
  const config = {
    hooks: {
      PreToolUse: [
        { hooks: [{ command: 'node C:/Users/test/.agent-lens/app/hooks/prelog.js' }] },
        { hooks: [{ command: 'node C:/tools/keep.js' }] },
      ],
      PostToolUse: [
        { hooks: [{ command: 'node C:/Users/test/.agent-lens/app/hooks/log.js' }] },
      ],
    },
  };

  assert.equal(removeAgentLensHooks(config), true);
  assert.deepEqual(config, {
    hooks: {
      PreToolUse: [{ hooks: [{ command: 'node C:/tools/keep.js' }] }],
    },
  });
});

test('uninstall updates hook files and rebuilds Codex trust state for remaining hooks', () => {
  const root = makeTempRoot();
  const hooksPath = path.join(root, 'hooks.json');
  const configPath = path.join(root, 'config.toml');
  fs.writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ command: 'node C:/Users/test/.agent-lens/app/hooks/prelog.js' }] },
        { hooks: [{ command: 'node C:/tools/keep.js' }] },
      ],
    },
  }, null, 2));
  fs.writeFileSync(configPath, [
    '[hooks.state]',
    '[hooks.state."old"]',
    'trusted_hash = "sha256:old"',
    '',
    '[features]',
    'example = true',
  ].join('\n'));

  assert.equal(uninstallHooksFromFile(hooksPath, 'Codex'), true);
  updateCodexTrustHash({ configPath, hooksPath, quiet: true });

  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  const config = fs.readFileSync(configPath, 'utf8');
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, 'node C:/tools/keep.js');
  assert.doesNotMatch(config, /sha256:old/);
  assert.equal((config.match(/trusted_hash = /g) || []).length, 1);
  assert.match(config, /\[features\]/);
});
