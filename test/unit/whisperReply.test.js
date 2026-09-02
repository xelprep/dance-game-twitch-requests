process.env.NODE_ENV = 'test';
process.env.SKIP_APP_STARTUP = '1';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyWhisperReply } = require('../../server.js');

test('classifyWhisperReply accepts common affirmative replies', () => {
  for (const reply of ['y', 'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'accept', 'accepted']) {
    assert.equal(classifyWhisperReply(reply), 'yes');
  }
});

test('classifyWhisperReply rejects common negative replies', () => {
  for (const reply of ['n', 'no', 'nope', 'nah', 'decline', 'declined']) {
    assert.equal(classifyWhisperReply(reply), 'no');
  }
});

test('classifyWhisperReply keeps ambiguous or empty replies pending', () => {
  assert.equal(classifyWhisperReply('maybe'), 'none');
  assert.equal(classifyWhisperReply(''), 'none');
  assert.equal(classifyWhisperReply('   '), 'none');
});
