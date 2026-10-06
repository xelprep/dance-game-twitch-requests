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
  ADVANCED_OPTIONS,
  ENV_OPTIONS,
  REQUIRED_OPTIONS,
  isDirectory,
  isValidControlPassword,
  writeEnvFile,
} = require("./setupConfig.cjs");
const { prepareDataDir } = require("./dataDir.cjs");
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const BACK_STEP = Symbol("back to previous setup step");
const BACK_INPUT = ":back";

// Read the currently effective value for every option: process.env -> .env -> "".
// Built-in defaults are not applied here; they are shown separately via each
// option's `default` and applied by the app when a value is left blank.
function readValues(envPath) {
  let fileValues = {};
  try {
    fileValues = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  } catch {
    // Missing .env is expected on first launch.
  }
  return Object.fromEntries(
    ENV_OPTIONS.map(({ key }) => [key, process.env[key] ?? fileValues[key] ?? ""]),
  );
}

function formatValue(option, value) {
  if (option.type === "boolean") return String(value).toLowerCase() === "true" ? "Yes" : "No";
  return String(value);
}

// The value to prefill a prompt with: the saved/current value when present,
// otherwise the option's built-in default. This lets the user accept defaults
// by pressing Enter on a first run, before anything has been saved to .env.
function effectiveDefault(option, currentValue) {
  return String(currentValue ?? "").trim() || String(option.default ?? "").trim();
}

// Build the "Current:" / "Default:" display lines for an option. When both a
// current value and a built-in default exist they are shown together (fixes
// current values being mislabeled as "default" on re-runs).
function valueDisplayLines(option, currentValue) {
  const current = String(currentValue ?? "").trim();
  const def = String(option.default ?? "").trim();
  if (option.type === "password") {
    return isValidControlPassword(current)
      ? ["Current: [hidden — a password is configured]"]
      : ["Current: (none)"];
  }
  if (current && def && current !== def) {
    return [`Current: ${formatValue(option, current)}`, `Default: ${formatValue(option, def)}`];
  }
  if (current && def && current === def) {
    return [`Current: ${formatValue(option, current)} (default)`];
  }
  if (current) return [`Current: ${formatValue(option, current)}`];
  if (def) return [`Default: ${formatValue(option, def)}`];
  return ["(not set)"];
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
  const promptDefault = effectiveDefault(option, currentValue);
  const answer = await input({
    message: `${option.label} (default: ${promptDefault}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: promptDefault,
    validate: (value) =>
      (canGoBack && value.trim() === BACK_INPUT) ||
      value.trim().length > 0 ||
      `${option.label} cannot be blank.`,
  });
  return canGoBack && answer.trim() === BACK_INPUT ? BACK_STEP : answer;
}

async function askInteger(option, currentValue, canGoBack) {
  const promptDefault = effectiveDefault(option, currentValue);
  const answer = await input({
    message: `${option.label} (default: ${promptDefault}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: promptDefault,
    validate: (value) => {
      if (canGoBack && value.trim() === BACK_INPUT) return true;
      if (!/^-?\d+$/.test(value.trim())) return "Enter a whole number.";
      return option.validate(Number(value)) || option.validationMessage;
    },
  });
  return canGoBack && answer.trim() === BACK_INPUT ? BACK_STEP : answer;
}

async function askPath(option, currentValue, canGoBack) {
  const promptDefault = effectiveDefault(option, currentValue);
  const value = await input({
    message: `${option.label} (default: ${promptDefault || "blank"}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: promptDefault,
  });
  return canGoBack && value.trim() === BACK_INPUT ? BACK_STEP : value;
}

async function askUrl(option, currentValue, canGoBack) {
  const promptDefault = effectiveDefault(option, currentValue);
  const answer = await input({
    message: `${option.label} (default: ${promptDefault || "blank"}${canGoBack ? `; type ${BACK_INPUT} to go back` : ""})`,
    default: promptDefault,
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
  const defaultValue = effectiveDefault(option, currentValue).toLowerCase() === "true";
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

async function runSetup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive setup needs a terminal. Run `npm run setup` from a terminal.");
    return false;
  }

  // Resolve and prepare the data root before asking anything. This is where the
  // "about to create this folder / relocate via data_dir.ini / offer to quit"
  // flow happens, and it determines where .env will be written.
  const dataDir = await prepareDataDir({ projectDir: projectDirectory, interactive: true });
  if (!dataDir) return false; // prepareDataDir already exited on failure
  const envFile = path.join(dataDir, ".env");

  const values = readValues(envFile);
  const updates = {};
  console.log(
    "\nDance Game Twitch Requests setup\nConfigure the local settings below. Twitch authorization remains in the control panel.\n",
  );
  console.log(`Settings are saved to ${envFile}.\n`);

  const requiredSteps = REQUIRED_OPTIONS;
  const advancedSteps = ADVANCED_OPTIONS;
  let state = "required";
  let index = 0;
  let advancedChosen = false;
  let songsCheckedFor = null;

  const askOption = async (option, canGoBack) => {
    const currentValue = updates[option.key] ?? values[option.key] ?? "";
    const lines = valueDisplayLines(option, currentValue);
    const display = lines.length ? "\n" + lines.join("\n") : "";
    console.log(`\n${option.label}\n${option.description}${display}`);
    if (option.type === "directory") return askDirectory(option, currentValue, canGoBack);
    if (option.type === "path") return askPath(option, currentValue, canGoBack);
    if (option.type === "integer") return askInteger(option, currentValue, canGoBack);
    if (option.type === "boolean") return askBoolean(option, currentValue, canGoBack);
    if (option.type === "password") return askPassword(currentValue, canGoBack);
    if (option.type === "url") return askUrl(option, currentValue, canGoBack);
    return askString(option, currentValue, canGoBack);
  };

  const storeAnswer = (option, answer) => {
    if (option.type === "password") updates[option.key] = answer.value;
    else updates[option.key] = option.type === "boolean" ? String(answer) : answer;
  };

  while (true) {
    if (state === "required") {
      if (index < requiredSteps.length) {
        const option = requiredSteps[index];
        const answer = await askOption(option, index > 0);
        if (answer === BACK_STEP) {
          index = Math.max(0, index - 1);
          continue;
        }
        if (answer === null) return false;
        storeAnswer(option, answer);
        index += 1;
        continue;
      }
      state = "advanced-question";
      continue;
    }

    if (state === "advanced-question") {
      const choice = await select({
        message: "Would you like to configure advanced options?",
        choices: [
          { name: "No, continue to the summary", value: "no" },
          { name: "Yes, configure advanced options", value: "yes" },
        ],
        default: "no",
      });
      if (choice === "yes") {
        advancedChosen = true;
        state = "advanced";
        index = 0;
        continue;
      }
      advancedChosen = false;
      state = "summary";
      continue;
    }

    if (state === "advanced") {
      if (index < advancedSteps.length) {
        const option = advancedSteps[index];
        const answer = await askOption(option, true);
        if (answer === BACK_STEP) {
          if (index > 0) {
            index -= 1;
            continue;
          }
          state = "advanced-question";
          continue;
        }
        if (answer === null) return false;
        storeAnswer(option, answer);
        index += 1;
        continue;
      }
      state = "summary";
      continue;
    }

    if (state === "summary") {
      // Validate the songs directory (warn when no simfiles are found). Re-check
      // only when SONGS_DIR has changed since the last check.
      if (songsCheckedFor !== (updates.SONGS_DIR || "")) {
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
            state = "required";
            index = 0;
            continue;
          }
          if (choice === "cancel") return false;
        }
        songsCheckedFor = updates.SONGS_DIR || "";
      }

      console.log("\nConfiguration summary:");
      for (const option of ENV_OPTIONS) {
        const value = option.type === "password" ? "[hidden]" : updates[option.key] || "(blank)";
        console.log(`  ${option.key}=${value}`);
      }
      const choice = await select({
        message: "Save setup configuration?",
        choices: [
          { name: `Write settings to ${path.basename(envFile)}`, value: "save" },
          { name: "Back to the previous setting", value: "back" },
          { name: "Cancel setup", value: "cancel" },
        ],
        default: "save",
      });
      if (choice === "back") {
        if (advancedChosen) {
          state = "advanced";
          index = advancedSteps.length - 1;
        } else {
          state = "advanced-question";
        }
        continue;
      }
      if (choice === "cancel") return false;
      break;
    }
  }

  const result = await writeEnvFile(envFile, updates);
  console.log(`\nConfiguration saved to ${envFile}.`);
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
