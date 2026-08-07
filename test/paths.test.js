const test = require('node:test');
const assert = require('node:assert/strict');

const { pickFirstExistingPath } = require('../server/paths');

test('picks the first existing path from candidate list before fallback', () => {
  const existing = __filename;
  const chosen = pickFirstExistingPath(['Z:/missing/opencode.db', existing], 'fallback.db');
  assert.equal(chosen, existing);
});

test('returns fallback when no candidates exist', () => {
  const chosen = pickFirstExistingPath(['Z:/missing/one.db', 'Z:/missing/two.db'], 'fallback.db');
  assert.equal(chosen, 'fallback.db');
});
