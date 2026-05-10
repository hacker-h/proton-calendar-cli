import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chmodOwnerOnly } from "../secret-file-safety.js";
import { DEFAULT_COOKIE_BUNDLE_PATH, DEFAULT_PROTON_BASE_URL } from "./constants.js";
import { CliError } from "./errors.js";

export async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmodOwnerOnly(filePath);
}


export async function writeServerEnv(filePath, values) {
  const lines = [
    `export API_BEARER_TOKEN=${quoteEnv(values.apiToken)}`,
    ...buildServerCalendarEnv(values),
    `export COOKIE_BUNDLE_PATH=${quoteEnv(values.cookieBundlePath)}`,
    `export PROTON_BASE_URL=${quoteEnv(values.protonBaseUrl)}`,
    `export PC_API_BASE_URL=${quoteEnv(values.apiBaseUrl)}`,
    `export PC_API_TOKEN=${quoteEnv(values.apiToken)}`,
    "",
    "# Optional unattended auth recovery (leave disabled unless you need runtime relogin):",
    "# export PROTON_AUTO_RELOGIN=\"1\"",
    "# export PROTON_RELOGIN_MODE=\"headless\"",
    "# export PROTON_RELOGIN_TIMEOUT_MS=\"120000\"",
    "# export PROTON_RELOGIN_POLL_SECONDS=\"3\"",
    "# export PROTON_RELOGIN_COOLDOWN_MS=\"300000\"",
    `# export PROTON_RELOGIN_LOCK_PATH=${quoteEnv(`${values.cookieBundlePath}.relogin.lock`)}`,
    "# export PROTON_RELOGIN_URL=\"https://calendar.proton.me/u/0\"",
    "",
  ];

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n"), { mode: 0o600 });
  await chmodOwnerOnly(filePath);
}


export async function updateServerEnvCalendarConfig(filePath, values) {
  const existing = await readServerEnvFile(filePath);
  await writeServerEnv(filePath, {
    apiToken: existing.API_BEARER_TOKEN || existing.PC_API_TOKEN || values.apiToken,
    targetCalendarId: null,
    defaultCalendarId: values.defaultCalendarId,
    allowedCalendarIds: values.allowedCalendarIds,
    cookieBundlePath: existing.COOKIE_BUNDLE_PATH || values.env.COOKIE_BUNDLE_PATH || path.resolve(DEFAULT_COOKIE_BUNDLE_PATH),
    protonBaseUrl: existing.PROTON_BASE_URL || values.env.PROTON_BASE_URL || DEFAULT_PROTON_BASE_URL,
    apiBaseUrl: existing.PC_API_BASE_URL || values.apiBaseUrl,
  });
}


async function readServerEnvFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliError("CONFIG_ERROR", `Server env file not found: ${filePath}`);
    }
    throw error;
  }

  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}


function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}


function buildServerCalendarEnv(values) {
  if (values.targetCalendarId) {
    return [`export TARGET_CALENDAR_ID=${quoteEnv(values.targetCalendarId)}`];
  }

  return [
    `export ALLOWED_CALENDAR_IDS=${quoteEnv(formatCsv(values.allowedCalendarIds || []))}`,
    `export DEFAULT_CALENDAR_ID=${quoteEnv(values.defaultCalendarId || "")}`,
  ];
}


function formatCsv(values) {
  return [...new Set(values)].join(",");
}


function quoteEnv(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}


