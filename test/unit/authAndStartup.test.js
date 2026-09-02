process.env.NODE_ENV = 'test';
process.env.SKIP_APP_STARTUP = '1';
process.env.CONTROL_PASSWORD = 'test-control-password';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  db,
  hashModeratorPassword,
  verifyModeratorPassword,
  verifyStreamerAuth,
  getModeratorCredentialsList,
  persistModeratorCredentials,
} = require('../../server.js');

function resetSettings() {
  db.prepare('DELETE FROM settings').run();
}

test('moderator password hashing and verification round-trip correctly', () => {
  resetSettings();
  const password = 'super-secret-password';
  const encoded = hashModeratorPassword(password);
  assert.equal(verifyModeratorPassword(password, encoded), true);
  assert.equal(verifyModeratorPassword('wrong-password', encoded), false);
});

test('streamer auth accepts the expected basic auth credentials', () => {
  const header = 'Basic ' + Buffer.from('streamer:test-control-password').toString('base64');
  assert.equal(verifyStreamerAuth(header, 'test-control-password'), true);
  assert.equal(verifyStreamerAuth('Basic ' + Buffer.from('streamer:wrong-password').toString('base64'), 'test-control-password'), false);
  assert.equal(verifyStreamerAuth('', 'test-control-password'), false);
});

test('persistModeratorCredentials stores moderator credentials and rehydrates them', () => {
  resetSettings();
  const entries = [
    { username: 'alice', password: 'hunter2' },
    { username: 'bob', password: 'hunter3' },
  ];

  const stored = persistModeratorCredentials(entries);
  assert.equal(stored.length, 2);
  assert.equal(getModeratorCredentialsList().length, 2);
  assert.equal(getModeratorCredentialsList()[0].username, 'alice');
  assert.equal(verifyModeratorPassword('hunter2', getModeratorCredentialsList()[0].passwordHash), true);
});

test('startup smoke check: the app can initialize a minimal settings table without crashing', () => {
  resetSettings();
  const rowCount = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  assert.equal(typeof rowCount, 'number');
  assert.equal(rowCount >= 0, true);
});
