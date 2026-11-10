const test = require('node:test');
const assert = require('node:assert/strict');
const { isServicePaused } = require('./service-pause');

const dbWith = (value, fail = false) => ({
  ref: (path) => ({ get: async () => { if (fail) throw new Error('boom'); return { val: () => value, path }; } }),
});

test('explicit flag wins over default', async () => {
  assert.equal(await isServicePaused(dbWith(true), 'x', false), true);
  assert.equal(await isServicePaused(dbWith(false), 'x', true), false);
});

test('missing or malformed flag uses default', async () => {
  assert.equal(await isServicePaused(dbWith(null), 'x', true), true);
  assert.equal(await isServicePaused(dbWith(null), 'x', false), false);
  assert.equal(await isServicePaused(dbWith('yes'), 'x', true), true);
});

test('read failure keeps the job running', async () => {
  assert.equal(await isServicePaused(dbWith(null, true), 'x', true), false);
});

test('reads the active flag of the given service', async () => {
  let asked = '';
  const db = { ref: (p) => ({ get: async () => { asked = p; return { val: () => null }; } }) };
  await isServicePaused(db, 'dontPressButton', true);
  assert.equal(asked, 'servicePause/dontPressButton/active');
});
