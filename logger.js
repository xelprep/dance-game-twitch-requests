const LEVELS = {
  log: "INFO",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  debug: "DEBUG",
};

function installConsoleLogger() {
  if (globalThis.__timestampedConsoleLoggerInstalled) return;
  globalThis.__timestampedConsoleLoggerInstalled = true;

  for (const [method, level] of Object.entries(LEVELS)) {
    const original = console[method];
    if (typeof original !== "function") continue;

    console[method] = (...args) => {
      const timestamp = new Date().toISOString();
      original.call(console, `[${timestamp}] [${level}]`, ...args);
    };
  }
}

module.exports = { installConsoleLogger };
