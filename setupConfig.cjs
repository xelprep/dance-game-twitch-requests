const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const ENV_OPTIONS = [
  {
    key: "SONGS_DIR",
    label: "Main Songs directory",
    description: "Root folder containing pack folders, song folders, and .sm/.ssc files.",
    type: "directory",
  },
  {
    key: "ADDITIONAL_SONGS_DIR",
    label: "Additional Songs directory",
    description: "Optional second library folder; matching packs are merged with the main library.",
    type: "directory",
    optional: true,
  },
  {
    key: "COURSES_DIR",
    label: "Generated course output directory",
    description:
      "Generated courses go in a Generated Courses subfolder; blank uses the default (./data/courses).",
    type: "directory",
    optional: true,
  },
  {
    key: "DB_DIR",
    label: "Database directory",
    description: "Directory for songs.db; leave blank for default (./data).",
    type: "directory",
    optional: true,
  },
  {
    key: "SCANNER_THREADS",
    label: "Scanner worker threads",
    description:
      "-1 uses all available CPU cores; a positive number caps parallel scanner and artwork workers.",
    type: "integer",
    validate: (value) => value === -1 || value > 0,
    validationMessage: "Enter -1 or a positive whole number.",
  },
  {
    key: "SECURE_MODE",
    label: "Secure startup mode",
    description: "When enabled, clears all saved moderator credentials at startup.",
    type: "boolean",
  },
  {
    key: "BOT_PREFIX",
    label: "Chat command prefix",
    description: "Prefix viewers type before bot commands.",
    type: "string",
  },
  {
    key: "SEARCH_COMMAND",
    label: "Search command name",
    description: "Command name used to search the song library in Twitch chat.",
    type: "string",
  },
  {
    key: "REQUEST_ID_COMMAND",
    label: "Request-by-ID command name",
    description: "Command name used to request a song by its displayed ID.",
    type: "string",
  },
  {
    key: "MAX_REQUESTS_PER_USER",
    label: "Maximum requests per viewer",
    description: "Maximum active requests one viewer may have in the queue.",
    type: "integer",
    validate: (value) => value > 0,
    validationMessage: "Enter a positive whole number.",
  },
  {
    key: "QUEUE_LIMIT",
    label: "Queue size limit",
    description: "Maximum number of songs allowed in the request queue.",
    type: "integer",
    validate: (value) => value > 0,
    validationMessage: "Enter a positive whole number.",
  },
  {
    key: "CONTROL_PASSWORD",
    label: "Control-panel password",
    description: "Password for streamer access to the authenticated control panel.",
    type: "password",
  },
  {
    key: "PUBLIC_URL",
    label: "Public website URL",
    description: "Optional publicly reachable URL shared with viewers for browsing and requests.",
    type: "url",
    optional: true,
  },
  {
    key: "PUBLIC_HTTPS",
    label: "Use HTTPS for the public website",
    description:
      "HTTPS is recommended. Choose No for OBS browser sources on a trusted local network, where HTTP avoids self-signed-certificate warnings. Do not expose the HTTP port directly to the Internet.",
    type: "boolean",
  },
  {
    key: "STREAMER_VANITY_NAME",
    label: "Streamer display name",
    description: "Name shown for streamer-added requests; defaults to Streamer.",
    type: "string",
  },
];

function parseEnvFile(contents) {
  return dotenv.parse(contents || "");
}

function isDirectory(value) {
  if (!value || !String(value).trim()) return false;
  try {
    return fs.statSync(path.resolve(String(value).trim())).isDirectory();
  } catch {
    return false;
  }
}

function isValidControlPassword(value) {
  const password = String(value || "").trim();
  return password.length > 0 && password !== "a-long-random-password";
}

function isSetupComplete(values) {
  return isDirectory(values.SONGS_DIR) && isValidControlPassword(values.CONTROL_PASSWORD);
}

function serializeEnvValue(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error("Environment values cannot contain line breaks.");
  if (!/[\s#]/.test(text)) return text;
  if (!text.includes("`")) return `\`${text}\``;
  if (!text.includes("'")) return `'${text}'`;
  throw new Error("Environment values cannot contain both apostrophes and backticks.");
}

function mergeEnvContents(contents, updates) {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents ? contents.split(/\r?\n/) : [];
  const updatedKeys = new Set();
  const mergedLines = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/);
    if (!match || !Object.hasOwn(updates, match[2])) return line;
    const [, prefix, key, assignment, oldValue] = match;
    const inlineComment = oldValue.match(/\s+#.*$/)?.[0] || "";
    updatedKeys.add(key);
    return `${prefix}${key}${assignment}${serializeEnvValue(updates[key])}${inlineComment}`;
  });
  const missingEntries = Object.entries(updates)
    .filter(([key]) => !updatedKeys.has(key))
    .map(([key, value]) => `${key}=${serializeEnvValue(value)}`);
  if (missingEntries.length) {
    if (mergedLines.length && mergedLines.at(-1) !== "") mergedLines.push("");
    mergedLines.push("# Added by the interactive setup wizard", ...missingEntries);
  }
  return mergedLines.join(newline).replace(/\n*$/, "") + newline;
}

async function writeEnvFile(envPath, updates) {
  const directory = path.dirname(envPath);
  const existed = fs.existsSync(envPath);
  const oldContents = existed ? fs.readFileSync(envPath, "utf8") : "";
  const nextContents = mergeEnvContents(oldContents, updates);
  let backupPath = null;
  if (existed && nextContents !== oldContents) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    backupPath = `${envPath}.${stamp}.bak`;
    fs.copyFileSync(envPath, backupPath, fs.constants.COPYFILE_EXCL);
  }
  const temporaryPath = path.join(
    directory,
    `.${path.basename(envPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, nextContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, envPath);
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // File mode changes are not supported by every filesystem.
    }
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
  return { backupPath };
}

function generateControlPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

module.exports = {
  ENV_OPTIONS,
  generateControlPassword,
  isDirectory,
  isSetupComplete,
  isValidControlPassword,
  mergeEnvContents,
  parseEnvFile,
  serializeEnvValue,
  writeEnvFile,
};
