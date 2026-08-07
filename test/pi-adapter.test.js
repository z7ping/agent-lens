const test = require('node:test');
const assert = require('node:assert/strict');

const PiAdapter = require('../server/adapters/pi');

test('polls enough Pi records to avoid truncating long sessions', async () => {
  const adapter = new PiAdapter();
  let requestedLimit = 0;

  adapter.getRecords = async (filter) => {
    requestedLimit = filter.limit;
    return [];
  };

  await adapter._pollOnce();

  assert.equal(requestedLimit, 10000);
});
