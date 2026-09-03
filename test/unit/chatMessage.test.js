process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const tmpSongsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dance-game-chat-"));
const songDir = path.join(tmpSongsDir, "pack", "Chat Song");
fs.mkdirSync(songDir, { recursive: true });
fs.writeFileSync(
  path.join(songDir, "chat-song.sm"),
  "#TITLE:Chat Song;\n#ARTIST:Chat Artist;\n#GENRE:Electronic;\n#NOTES:dance-single:1:Hard:10:1.000000:0.000000:0.000000;\n",
  "utf8",
);
process.env.SONGS_DIR = tmpSongsDir;

const {
  db,
  getSongSearchRows,
  scanSongs,
  handleChatMessage,
  getOnlineUsers,
} = require("../../server.js");

scanSongs(tmpSongsDir, db);

function createMockClient() {
  const sent = [];
  return {
    sent,
    client: {
      say: async (channel, message) => {
        sent.push({ channel, message });
      },
    },
    cfg: { channel: "#testchannel" },
  };
}

function resetRequests() {
  db.prepare("DELETE FROM requests").run();
}

test("regular user can make a chat request with !requestid without ReferenceError on display", async () => {
  resetRequests();
  const { client, cfg, sent } = createMockClient();
  const song = getSongSearchRows(10, "")[0];
  assert.ok(song, "expected at least one song");

  const tags = {
    username: "alice_dancer",
    "display-name": "AliceDancer",
  };

  // Should succeed without throwing "ReferenceError: display is not defined"
  await handleChatMessage(client, cfg, "#testchannel", tags, `!requestid ${song.id}`, false);

  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].message.includes("@AliceDancer, added \"Chat Song\" to the request queue!"),
    `Unexpected message: ${sent[0].message}`,
  );

  // Online users should include AliceDancer
  const online = getOnlineUsers();
  assert.ok(online.some((u) => u.username === "alice_dancer" && u.displayName === "AliceDancer"));
});

test("bot user (self=true) can make a chat request without ReferenceError and is not added to chatUsers", async () => {
  resetRequests();
  const { client, cfg, sent } = createMockClient();
  const song = getSongSearchRows(10, "")[0];

  const tags = {
    username: "bot_account",
    "display-name": "BotAccount",
  };

  // Bot sends command
  await handleChatMessage(client, cfg, "#testchannel", tags, `!requestid ${song.id}`, true);

  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].message.includes("@BotAccount, added \"Chat Song\" to the request queue!"),
    `Unexpected message: ${sent[0].message}`,
  );

  // Online users should NOT include bot_account (per PR #68 / commit 2a24e3f0)
  const online = getOnlineUsers();
  assert.ok(!online.some((u) => u.username === "bot_account"));
});

test("duplicate request correctly formats error reply using display without ReferenceError", async () => {
  // Alice already requested this song above; requesting again should trigger catch block
  const { client, cfg, sent } = createMockClient();
  const song = getSongSearchRows(10, "")[0];

  const tags = {
    username: "alice_dancer",
    "display-name": "AliceDancer",
  };

  // Second request triggers catch (e) { await sendChatMessage(client, cfg.channel, `@${display}, ${e.message}`); }
  await handleChatMessage(client, cfg, "#testchannel", tags, `!requestid ${song.id}`, false);

  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].message.includes("@AliceDancer"),
    `Expected message to contain @AliceDancer, got: ${sent[0].message}`,
  );
  assert.ok(
    sent[0].message.toLowerCase().includes("already queued"),
    `Expected duplicate error message, got: ${sent[0].message}`,
  );
});

test("!queue and !search correctly use display for replies", async () => {
  const { client, cfg, sent } = createMockClient();

  const tags = {
    username: "chatter",
    "display-name": "CoolChatter",
  };

  await handleChatMessage(client, cfg, "#testchannel", tags, "!queue", false);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.includes("@CoolChatter"));

  await handleChatMessage(client, cfg, "#testchannel", tags, "!search Chat", false);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].message.includes("@CoolChatter"));
  assert.ok(sent[1].message.includes("Chat Song"));
});
