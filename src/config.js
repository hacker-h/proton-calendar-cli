import { ApiError } from "./errors.js";

export function loadConfigFromEnv(env = process.env) {
  const apiBearerToken = readRequired(env.API_BEARER_TOKEN, "API_BEARER_TOKEN");
  const targetCalendarId = readOptional(env.TARGET_CALENDAR_ID);
  const allowedCalendarIds = readCsv(env.ALLOWED_CALENDAR_IDS);
  const defaultCalendarId = readOptional(env.DEFAULT_CALENDAR_ID) || targetCalendarId || allowedCalendarIds[0] || null;

  return {
    port: readNumber(env.PORT, 8787),
    targetCalendarId,
    defaultCalendarId,
    allowedCalendarIds,
    apiBearerToken,
    cookieBundlePath: env.COOKIE_BUNDLE_PATH || "secrets/proton-cookies.json",
    protonBaseUrl: env.PROTON_BASE_URL || "https://calendar.proton.me",
    protonTimeoutMs: readNumber(env.PROTON_TIMEOUT_MS, 10000),
    protonMaxRetries: readNumber(env.PROTON_MAX_RETRIES, 2),
    protonAuthDebug: readBoolean(env.PROTON_AUTH_DEBUG, false),
    protonAutoRelogin: readBoolean(env.PROTON_AUTO_RELOGIN, false),
    protonReloginMode: readEnum(env.PROTON_RELOGIN_MODE, ["disabled", "headless", "headful", "hybrid"], "hybrid"),
    protonChromePath: readOptional(env.PROTON_CHROME_PATH),
    protonProfileDir: readOptional(env.PROTON_PROFILE_DIR),
    protonReloginTimeoutMs: readNumber(env.PROTON_RELOGIN_TIMEOUT_MS, 120000),
    protonReloginPollSeconds: readNumber(env.PROTON_RELOGIN_POLL_SECONDS, 3),
    protonReloginUrl: readOptional(env.PROTON_RELOGIN_URL) || "https://calendar.proton.me/u/0",
  };
}

export function assertConfig(config) {
  if (!config.apiBearerToken) {
    throw new ApiError(500, "CONFIG_ERROR", "API_BEARER_TOKEN is required");
  }

  const allowed = new Set(config.allowedCalendarIds || []);
  if (config.targetCalendarId) {
    allowed.add(config.targetCalendarId);
  }

  if (allowed.size === 0) {
    throw new ApiError(500, "CONFIG_ERROR", "Set TARGET_CALENDAR_ID or ALLOWED_CALENDAR_IDS");
  }

  if (config.defaultCalendarId && !allowed.has(config.defaultCalendarId)) {
    throw new ApiError(500, "CONFIG_ERROR", "DEFAULT_CALENDAR_ID must be in TARGET/ALLOWED calendar IDs");
  }
}

function readRequired(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function readOptional(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readCsv(value) {
  if (typeof value !== "string") {
    return [];
  }

  const unique = new Set();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return [...unique];
}

function readNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function readBoolean(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readEnum(value, allowedValues, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return allowedValues.includes(normalized) ? normalized : fallback;
}
