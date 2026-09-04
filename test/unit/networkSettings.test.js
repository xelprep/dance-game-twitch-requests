process.env.NODE_ENV = "test";
process.env.SKIP_APP_STARTUP = "1";
process.env.CONTROL_PASSWORD = "test-control-password";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const net = require("net");

const {
  checkPortsAvailable,
  createApi,
  db,
  getControlSettings,
  getLanIPv4Addresses,
  getNetworkSettings,
  isValidIPv4,
  isValidPort,
  networkProblemMessage,
  setSetting,
} = require("../../server.js");

function resetSettings() {
  db.prepare("DELETE FROM settings").run();
}

function startControlApp() {
  const app = express();
  createApi(app, { control: true });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function authHeader() {
  return "Basic " + Buffer.from("streamer:test-control-password").toString("base64");
}

test("getNetworkSettings returns the defaults when nothing valid is saved", () => {
  resetSettings();
  assert.deepEqual(getNetworkSettings(), {
    host: "0.0.0.0",
    publicPort: 3000,
    controlPort: 3001,
  });
});

test("getNetworkSettings round-trips saved host and ports", () => {
  resetSettings();
  setSetting("host", "127.0.0.1");
  setSetting("publicPort", 4000);
  setSetting("controlPort", 4001);
  assert.deepEqual(getNetworkSettings(), {
    host: "127.0.0.1",
    publicPort: 4000,
    controlPort: 4001,
  });
});

test("getNetworkSettings falls back to defaults for corrupt saved values", () => {
  resetSettings();
  setSetting("host", "not-an-ip");
  setSetting("publicPort", 70000);
  setSetting("controlPort", 0);
  assert.deepEqual(getNetworkSettings(), {
    host: "0.0.0.0",
    publicPort: 3000,
    controlPort: 3001,
  });
});

test("getControlSettings exposes host, ports and detected LAN addresses", () => {
  resetSettings();
  const settings = getControlSettings();
  assert.ok(settings.host === "0.0.0.0" || isValidIPv4(settings.host));
  assert.ok(isValidPort(settings.publicPort));
  assert.ok(isValidPort(settings.controlPort));
  assert.ok(Array.isArray(settings.lanIPs));
  assert.ok(Array.isArray(getLanIPv4Addresses()));
});

test("isValidPort accepts only integer ports between 1 and 65535", () => {
  assert.equal(isValidPort(3000), true);
  assert.equal(isValidPort(1), true);
  assert.equal(isValidPort(65535), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort(65536), false);
  assert.equal(isValidPort(1.5), false);
  assert.equal(isValidPort("3000"), false);
  assert.equal(isValidPort(NaN), false);
  assert.equal(isValidPort(undefined), false);
});

test("isValidIPv4 accepts only well-formed dotted-quad IPv4 addresses", () => {
  assert.equal(isValidIPv4("0.0.0.0"), true);
  assert.equal(isValidIPv4("127.0.0.1"), true);
  assert.equal(isValidIPv4("192.168.1.50"), true);
  assert.equal(isValidIPv4("256.1.1.1"), false);
  assert.equal(isValidIPv4("1.2.3"), false);
  assert.equal(isValidIPv4("1.2.3.4.5"), false);
  assert.equal(isValidIPv4("1.2.3.a"), false);
  assert.equal(isValidIPv4(""), false);
});

test("checkPortsAvailable reports an invalid port", async () => {
  const problem = await checkPortsAvailable({
    host: "127.0.0.1",
    publicPort: 0,
    controlPort: 3001,
  });
  assert.equal(problem.code, "invalid-port");
  assert.equal(problem.port, 0);
});

test("checkPortsAvailable reports the public and control ports being the same", async () => {
  const problem = await checkPortsAvailable({
    host: "127.0.0.1",
    publicPort: 4123,
    controlPort: 4123,
  });
  assert.equal(problem.code, "same-port");
  assert.equal(problem.port, 4123);
});

test("checkPortsAvailable reports a port already held by another process", async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const busyPort = holder.address().port;
  try {
    const problem = await checkPortsAvailable({
      host: "127.0.0.1",
      publicPort: busyPort,
      controlPort: 4124,
    });
    assert.equal(problem.code, "in-use");
    assert.equal(problem.port, busyPort);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("checkPortsAvailable returns null when both ports are free", async () => {
  // Bind two throwaway servers on ephemeral ports, close them, and probe the
  // now-released ports: they should read as available.
  const probeA = net.createServer();
  const probeB = net.createServer();
  await new Promise((resolve) => probeA.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => probeB.listen(0, "127.0.0.1", resolve));
  const portA = probeA.address().port;
  const portB = probeB.address().port;
  await new Promise((resolve) => probeA.close(resolve));
  await new Promise((resolve) => probeB.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const problem = await checkPortsAvailable({
    host: "127.0.0.1",
    publicPort: portA,
    controlPort: portB,
  });
  assert.equal(problem, null);
});

test("networkProblemMessage includes actionable advice for each problem type", () => {
  const invalid = networkProblemMessage({ code: "invalid-port", port: 70000 });
  assert.ok(invalid.includes("70000"));
  assert.ok(invalid.includes("65535"));

  const samePort = networkProblemMessage({ code: "same-port", port: 3000 });
  assert.ok(samePort.includes("3000"));
  assert.ok(samePort.toLowerCase().includes("different"));

  const inUse = networkProblemMessage({ code: "in-use", port: 3000 });
  assert.ok(inUse.includes("3000"));
  assert.ok(inUse.includes("lsof -i :3000"));
  assert.ok(inUse.includes("netstat -ano | findstr :3000"));
});

test("control settings API exposes the runtime network settings", async () => {
  const server = await startControlApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      headers: { Accept: "application/json", Authorization: authHeader() },
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.ok(payload.host === "0.0.0.0" || isValidIPv4(payload.host));
    assert.ok(isValidPort(payload.publicPort));
    assert.ok(isValidPort(payload.controlPort));
    assert.ok(Array.isArray(payload.lanIPs));
  } finally {
    server.close();
  }
});

test("control settings API persists valid host and port values", async () => {
  resetSettings();
  const server = await startControlApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify({ host: "127.0.0.1", publicPort: 4000, controlPort: 4001 }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.host, "127.0.0.1");
    assert.equal(payload.publicPort, 4000);
    assert.equal(payload.controlPort, 4001);
  } finally {
    server.close();
  }
});

test("control settings API rejects invalid host and port values", async () => {
  resetSettings();
  const server = await startControlApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify({ host: "not-an-ip", publicPort: 70000, controlPort: 1.5 }),
    });
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    // Invalid values are dropped and the current (valid) settings are kept.
    assert.notEqual(payload.host, "not-an-ip");
    assert.ok(payload.host === "0.0.0.0" || isValidIPv4(payload.host));
    assert.notEqual(payload.publicPort, 70000);
    assert.notEqual(payload.controlPort, 1.5);
    assert.ok(isValidPort(payload.publicPort));
    assert.ok(isValidPort(payload.controlPort));
  } finally {
    server.close();
  }
});

test("restart endpoint is unavailable (503) when servers do not start", async () => {
  const server = await startControlApp();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/control/restart`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: authHeader() },
    });
    assert.equal(res.status, 503);
    const payload = await res.json();
    assert.equal(payload.ok, false);
    assert.ok(typeof payload.error === "string" && payload.error.length > 0);
  } finally {
    server.close();
  }
});
