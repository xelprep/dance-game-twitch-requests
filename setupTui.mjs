import { input, password, select } from "@inquirer/prompts";
import { fileSelector, ItemType } from "inquirer-file-selector";
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ENV_OPTIONS,
  isDirectory,
  isValidControlPassword,
  writeEnvFile,
} = require("./setupConfig.cjs");
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const BACK_STEP = Symbol("back to previous setup step");
const BACK_INPUT = ":back";

function readValues(filePath) {
  let templateValues = {};
  let currentValues = {};
  try {
    templateValues = dotenv.parse(
      fs.readFileSync(path.join(projectDirectory, ".env.example"), "utf8"),
    );
  } catch {
    // Built-in defaults keep setup usable without the example file.
  }
  try {
    currentValues = dotenv.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // Missing .env is expected on first launch.
  }
  return Object.fromEntries(
    ENV_OPTIONS.map(({ key }) => [
      key,
      process.env[key] ?? currentValues[key] ?? templateValues[key] ?? "",
    ]),
  );
}

function displayDefault(option, value) {
  if (option.type === "password") {
    return isValidControlPassword(value)
      ? "configured password (hidden; choose Keep to retain)"
      : "enter a secure password";
  }
  if (option.type === "directory" || option.type === "path") return value || "(blank / disabled)";
  return value;
}

function backChoice(allowed) {
  return allowed ? [{ name: "Back to previous step", value: BACK_STEP }] : [];
}

async function askDirectory(option, currentValue, canGoBack) {
  while (true) {
    const hasCurrent = currentValue && isDirectory(currentValue);
    const choices = [
      { name: "Browse folders", value: "browse" },
      { name: "Type or edit a path", value: "type" },
    ];
    if (hasCurrent) choices.push({ name: "Keep current value", value: "keep" });
    if (option.optional) choices.push({ name: "Leave blank / disable", value: "blank" });
    choices.push(...backChoice(canGoBack));
    const method = await select({
      message: `${option.label} (default: ${currentValue || (option.optional ? "blank" : "choose a folder")})`,
      choices,
      default: hasCurrent ? "keep" : option.optional ? "blank" : "browse",
    });
    if (method === BACK_STEP) return BACK_STEP;
    if (method === "keep") return currentValue;
    if (method === "blank") return "";
    if (method === "type") {
      const selection = await input({
        message: `Directory path (type ${BACK_INPUT} to go back)`,
        default: currentValue,
        validate: (value) =>
          (canGoBack && value.trim() === BACK_INPUT) ||
          !value.trim() ||
          isDirectory(value) ||
          "Enter an existing directory path.",
      });
      if (canGoBack && selection.trim() === BACK_INPUT) return BACK_STEP;
      if (!selection.trim() && option.optional) return "";
      if (isDirectory(selection)) return path.resolve(selection.trim());
    } else {
      const item = await fileSelector({
        message: `Choose ${option.label.toLowerCase()} (Enter opens folder; Space selects folder)`,
        basePath: hasCurrent ? path.resolve(currentValue) : os.homedir(),
        type: ItemType.Directory,
        allowCancel: true,
        keybinds: {
          forward: ["enter", "return"],
          confirm: ["space"],
          toggle: ["t"],
        },
        theme: {
          labels: {
            keys: { forward: "Enter", confirm: "Space", toggle: "T" },
            hints: {
              goForward: "{{forward}} to open folder",
              confirm: "{{confirm}} to select folder",
            },
          },
        },
      });
      if (!item) return canGoBack ? BACK_STEP : null;
      if (isDirectory(item.path)) return path.resolve(item.path);
    }
    console.log("That path is not an accessible directory. Try again.");
  }
}

async function askString(option, currentValue, canGoBack) {
  const answer = await input({
    message: `${option.label} (default: ${currentValue}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: currentValue,
    validate: (value) =>
      (canGoBack && value.trim() === BACK_INPUT) ||
      value.trim().length > 0 ||
      `${option.label} cannot be blank.`,
  });
  return canGoBack && answer.trim() === BACK_INPUT ? BACK_STEP : answer;
}

async function askInteger(option, currentValue, canGoBack) {
  const answer = await input({
    message: `${option.label} (default: ${currentValue}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: currentValue,
    validate: (value) => {
      if (canGoBack && value.trim() === BACK_INPUT) return true;
      if (!/^-?\d+$/.test(value.trim())) return "Enter a whole number.";
      return option.validate(Number(value)) || option.validationMessage;
    },
  });
  return canGoBack && answer.trim() === BACK_INPUT ? BACK_STEP : answer;
}

async function askPath(option, currentValue, canGoBack) {
  const value = await input({
    message: `${option.label} (default: ${currentValue || "blank"}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: currentValue,
  });
  return canGoBack && value.trim() === BACK_INPUT ? BACK_STEP : value;
}

async function askUrl(option, currentValue, canGoBack) {
  const answer = await input({
    message: `${option.label} (default: ${currentValue || "blank"}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: currentValue,
    validate: (value) => {
      if (canGoBack && value.trim() === BACK_INPUT) return true;
      if (!value.trim()) return true;
      try {
        return (
          ["http:", "https:"].includes(new URL(value).protocol) ||
          "Enter an http(s) URL or leave blank."
        );
      } catch {
        return "Enter an http(s) URL or leave blank.";
      }
    },
  });
  return canGoBack && answer.trim() === BACK_INPUT ? BACK_STEP : answer;
}

async function askPassword(currentValue, canGoBack) {
  const keepExisting = isValidControlPassword(currentValue);
  const method = await select({
    message: `Control-panel password (default: ${keepExisting ? "keep current, hidden" : "enter a secure password"})`,
    default: keepExisting ? "keep" : "custom",
    choices: [
      ...(keepExisting ? [{ name: "Keep current password", value: "keep" }] : []),
      { name: "Enter a custom password", value: "custom" },
      ...backChoice(canGoBack),
    ],
  });
  if (method === BACK_STEP) return BACK_STEP;
  if (method === "keep") return { value: currentValue };
  while (true) {
    const value = await password({
      message: `New control-panel password (minimum 12 characters; type ${BACK_INPUT} to go back)`,
      mask: "*",
      validate: (answer) =>
        (canGoBack && answer.trim() === BACK_INPUT) ||
        answer.trim().length >= 12 ||
        "Use at least 12 characters.",
    });
    if (canGoBack && value.trim() === BACK_INPUT) return BACK_STEP;
    const confirmation = await password({
      message: `Re-enter the control-panel password to verify it${canGoBack ? ` (type ${BACK_INPUT} to edit)` : ""}`,
      mask: "*",
      validate: (answer) =>
        (canGoBack && answer.trim() === BACK_INPUT) ||
        answer === value ||
        "Passwords do not match. Enter the same password again.",
    });
    if (canGoBack && confirmation.trim() === BACK_INPUT) continue;
    return { value: value.trim() };
  }
}

async function askBoolean(option, currentValue, canGoBack) {
  const defaultValue = currentValue.toLowerCase() === "true";
  const choices = [
    { name: "Yes", value: true },
    { name: "No", value: false },
    ...backChoice(canGoBack),
  ];
  return select({
    message: `${option.label} (default: ${defaultValue ? "Yes" : "No"})`,
    choices,
    default: defaultValue,
  });
}

function hasSongFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).some((pack) => {
      if (!pack.isDirectory()) return false;
      return fs
        .readdirSync(path.join(directory, pack.name), { withFileTypes: true })
        .some((song) => {
          if (!song.isDirectory()) return false;
          return fs
            .readdirSync(path.join(directory, pack.name, song.name))
            .some((name) => /\.(sm|ssc)$/i.test(name));
        });
    });
  } catch {
    return false;
  }
}

async function runSetup({ envPath = path.resolve(process.cwd(), ".env") } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Interactive setup needs a terminal. Run `npm run setup` from a terminal, or configure .env manually.",
    );
    return false;
  }

  const values = readValues(envPath);
  const updates = {};
  console.log(
    "\nDance Game Twitch Requests setup\nConfigure the local settings below. Twitch authorization remains in the control panel.\n",
  );

  let index = 0;
  while (true) {
    for (; index < ENV_OPTIONS.length; index += 1) {
      const option = ENV_OPTIONS[index];
      const currentValue = updates[option.key] ?? values[option.key] ?? "";
      const canGoBack = index > 0;
      const defaultLine =
        option.type === "boolean"
          ? ""
          : `\nCurrent/default: ${displayDefault(option, currentValue)}`;
      console.log(`\n${option.label}\n${option.description}${defaultLine}`);
      let answer;
      if (option.type === "directory") {
        answer = await askDirectory(option, currentValue, canGoBack);
      } else if (option.type === "path") {
        answer = await askPath(option, currentValue, canGoBack);
      } else if (option.type === "integer") {
        answer = await askInteger(option, currentValue, canGoBack);
      } else if (option.type === "boolean") {
        answer = await askBoolean(option, currentValue, canGoBack);
      } else if (option.type === "password") {
        answer = await askPassword(currentValue, canGoBack);
      } else if (option.type === "url") {
        answer = await askUrl(option, currentValue, canGoBack);
      } else {
        answer = await askString(option, currentValue, canGoBack);
      }
      if (answer === BACK_STEP) {
        index = Math.max(0, index - 1);
        break;
      }
      if (answer === null) return false;
      if (option.type === "password") {
        updates[option.key] = answer.value;
      } else {
        updates[option.key] = option.type === "boolean" ? String(answer) : answer;
      }
    }
    if (index < ENV_OPTIONS.length) continue;

    if (!updates.SONGS_DIR)
      throw new Error("SONGS_DIR is required. Choose a main Songs directory to continue.");
    if (!hasSongFiles(updates.SONGS_DIR)) {
      const choice = await select({
        message: "No .sm/.ssc files were found in pack/song folders.",
        choices: [
          { name: "Go back to choose the Songs directory", value: "back" },
          { name: "Save this directory anyway", value: "continue" },
          { name: "Cancel setup", value: "cancel" },
        ],
        default: "back",
      });
      if (choice === "back") {
        index = 0;
        continue;
      }
      if (choice === "cancel") return false;
    }

    console.log("\nConfiguration summary:");
    for (const option of ENV_OPTIONS) {
      const value = option.type === "password" ? "[hidden]" : updates[option.key] || "(blank)";
      console.log(`  ${option.key}=${value}`);
    }
    const choice = await select({
      message: "Save setup configuration?",
      choices: [
        { name: "Write settings to .env", value: "save" },
        { name: "Back to the previous setting", value: "back" },
        { name: "Cancel setup", value: "cancel" },
      ],
      default: "save",
    });
    if (choice === "back") {
      index = ENV_OPTIONS.length - 1;
      continue;
    }
    if (choice === "cancel") return false;
    break;
  }

  const result = await writeEnvFile(envPath, updates);
  console.log(`\nConfiguration saved to ${envPath}.`);
  if (result.backupPath) console.log(`Previous configuration backed up to ${result.backupPath}.`);
  console.log(
    "Start the app with `npm start`, then open https://localhost:3001 and sign in with your streamer display name.",
  );
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup()
    .then((success) => {
      if (!success) process.exitCode = 1;
    })
    .catch((error) => {
      if (error?.name === "ExitPromptError" || error?.name === "AbortPromptError") {
        console.log("\nSetup canceled; no configuration was written.");
        process.exitCode = 1;
        return;
      }
      console.error(`Setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}

export { runSetup };
