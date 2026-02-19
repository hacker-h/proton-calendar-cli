import { ApiError } from "./errors.js";

export function loadConfigFromEnv(env = process.env) {
  const targetCalendarId = readRequired(env.TARGET_CALENDAR_ID, "TARGET_CALENDAR_ID");
  const apiBearerToken = readRequired(env.API_BEARER_TOKEN, "API_BEARER_TOKEN");

  return {
    port: readNumber(env.PORT, 8787),
    targetCalendarId,
    apiBearerToken,
    cookieBundlePath: env.COOKIE_BUNDLE_PATH || "secrets/proton-cookies.json",
    protonBaseUrl: env.PROTON_BASE_URL || "https://calendar.proton.me",
    protonTimeoutMs: readNumber(env.PROTON_TIMEOUT_MS, 10000),
    protonMaxRetries: readNumber(env.PROTON_MAX_RETRIES, 2),
  };
}

export function assertConfig(config) {
  if (!config.targetCalendarId) {
    throw new ApiError(500, "CONFIG_ERROR", "TARGET_CALENDAR_ID is required");
  }
  if (!config.apiBearerToken) {
    throw new ApiError(500, "CONFIG_ERROR", "API_BEARER_TOKEN is required");
  }
}

function readRequired(value, key) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function readNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}
