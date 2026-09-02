process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createApi, db, hashModeratorPassword, setSetting } = require("../../server.js");

function resetSettings() {
  db.prepare("DELETE FROM settings").run();
}

function startPublicModeratorApp() {
  const app = express();
  createApi(app, { moderator: true });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function startControlApp() {
  const app = express();
  createApi(app, { control: true });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test("public API search returns song rows and supports basic filtering", async () => {
  resetSettings();
  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/search?q=queue`, {
      headers: { Accept: "application/json" },
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json));
  } finally {
    server.close();
  }
});

test("moderator settings API rejects invalid auth and accepts valid moderator auth", async () => {
  resetSettings();
  setSetting("moderatorEnabled", true);
  setSetting("moderatorCredentials", [
    { username: "alice", passwordHash: hashModeratorPassword("hunter2") },
  ]);
  setSetting("moderatorUsername", "alice");

  const server = await startPublicModeratorApp();
  const port = server.address().port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/moderator/settings`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/moderator/settings`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from("alice:hunter2").toString("base64"),
      },
    });

    assert.equal(authorized.status, 200);
    const payload = await authorized.json();
    assert.ok(payload && typeof payload === "object");
  } finally {
    server.close();
  }
});

test("control settings API stores valid streamer credentials and updates settings", async () => {
  resetSettings();
  const server = await startControlApp();
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from("streamer:test-control-password").toString("base64"),
      },
      body: JSON.stringify({
        prioritizeViewerRequests: true,
        chatRequestsEnabled: true,
        chatRequestsRequireRole: "follower",
        moderatorEnabled: true,
        moderatorUsername: "alice",
        moderatorCredentials: [{ username: "alice", password: "hunter2" }],
        instructionsMinutes: 10,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.moderatorEnabled, true);
  } finally {
    server.close();
  }
});
