const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_LIFECYCLE_EVENTS,
  configureCodexHooks,
  formatNodeHookCommand,
  removeAgentLensHooks,
  uninstallHooksFromFile,
  updateCodexTrustHash,
} = require('../server/install-hooks');
const { inspectCodexHookCoverage } = require('../server/sources-status');

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

test('configures every Codex lifecycle hook idempotently while preserving unrelated hooks', () => {
  const config = {
    hooks: {
      SessionStart: [{ hooks: [{ command: 'node C:/tools/keep.js' }] }],
      Stop: [{ hooks: [{ command: 'node C:/old/agent-lens/hooks/codex-lifecycle.js' }] }],
    },
  };
  const options = {
    prelogPath: 'C:/agent-lens/hooks/prelog.js',
    logPath: 'C:/agent-lens/hooks/log.js',
    lifecyclePath: 'C:/agent-lens/hooks/codex-lifecycle.js',
  };

  configureCodexHooks(config, options);
  configureCodexHooks(config, options);

  assert.equal(config.hooks.PreToolUse.length, 1);
  assert.equal(config.hooks.PostToolUse.length, 1);
  for (const eventName of CODEX_LIFECYCLE_EVENTS) {
    const ownHooks = config.hooks[eventName].filter(group =>
      group.hooks.some(hook => hook.command.includes('agent-lens')),
    );
    assert.equal(ownHooks.length, 1, `${eventName} should contain one AgentLens hook`);
    assert.equal(ownHooks[0].hooks[0].async, false);
  }
  assert.equal(config.hooks.SessionEnd.at(-1).hooks[0].timeout, 3);
  assert.equal(config.hooks.SessionStart.at(-1).hooks[0].timeout, 5);
  assert.equal(config.hooks.SessionStart.length, 2, 'unrelated SessionStart hook should be preserved');
  const coverage = inspectCodexHookCoverage(JSON.stringify(config));
  assert.deepEqual(coverage, { configured: 11, expected: 11, complete: true, missingEvents: [] });
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
