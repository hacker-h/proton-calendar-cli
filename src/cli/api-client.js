import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { CliError } from "./errors.js";

export async function requestJson(fetchImpl, request) {
  const url = new URL(`${request.apiBaseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${request.apiToken}`,
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError("API_UNREACHABLE", `Unable to reach API at ${request.apiBaseUrl}`, {
      message: error?.message,
    });
  }

  const text = await response.text();
  const payload = parseMaybeJson(text);

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") || payload?.error?.requestId || null;
    throw new CliError(
      payload?.error?.code || "API_ERROR",
      payload?.error?.message || `API request failed (${response.status})`,
      addRequestIdToDetails(payload?.error?.details, requestId)
    );
  }

  return payload;
}

export function parseMaybeJson(text) {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      data: {
        raw: text,
      },
    };
  }
}

export function readRetryAfterDetails(response) {
  const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
  if (!Number.isFinite(retryAfterMs)) {
    return {};
  }
  return {
    retryAfterMs,
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  };
}

export function parseJsonObject(raw, errorMessage) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("INVALID_ARGS", errorMessage);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("INVALID_ARGS", errorMessage);
  }
  return parsed;
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) {
    return Number.NaN;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) {
    return Number.NaN;
  }
  return Math.max(0, dateMs - nowMs);
}

function addRequestIdToDetails(details, requestId) {
  if (!requestId) {
    return details;
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { requestId };
  }
  return {
    ...details,
    requestId,
  };
}
