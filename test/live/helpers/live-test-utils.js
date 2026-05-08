import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function readLiveConfig(env = process.env) {
  const apiBaseUrl = String(env.PC_API_BASE_URL || env.API_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const apiToken = String(env.PC_API_TOKEN || env.API_BEARER_TOKEN || "").trim();
  const calendarId = String(env.PROTON_TEST_CALENDAR_ID || env.TARGET_CALENDAR_ID || env.DEFAULT_CALENDAR_ID || "").trim() || null;
  const enabled = Boolean(apiBaseUrl && apiToken);

  return {
    enabled,
    apiBaseUrl,
    apiToken,
    calendarId,
    titlePrefix: env.PROTON_TEST_TITLE_PREFIX || `ci-e2e-${randomUUID().slice(0, 8)}`,
  };
}

export function buildEventTitle(config, suffix) {
  return `${config.titlePrefix} ${suffix}`;
}

export async function apiRequest(config, method, route, body) {
  const response = await fetch(`${config.apiBaseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "X-Idempotency-Key": randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    body: parsed,
  };
}

export function buildCollectionRoute(config, query, options = {}) {
  const useCalendarRoute = options.useCalendarRoute !== false;
  return config.calendarId && useCalendarRoute
    ? `/v1/calendars/${encodeURIComponent(config.calendarId)}/events${buildQuery(query)}`
    : `/v1/events${buildQuery(query)}`;
}

export function buildEventRoute(config, eventId, query, options = {}) {
  const useCalendarRoute = options.useCalendarRoute !== false;
  const base = config.calendarId && useCalendarRoute
    ? `/v1/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`
    : `/v1/events/${encodeURIComponent(eventId)}`;
  return `${base}${buildQuery(query)}`;
}

export async function waitForApi(config, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${config.apiBaseUrl}/v1/health`, {
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw lastError || new Error("API did not become ready in time");
}

export async function cleanupEvents(config, start, end) {
  const listed = await apiRequest(config, "GET", buildCollectionRoute(config, { start, end, limit: 200 }));
  if (listed.status !== 200) {
    return;
  }

  const events = Array.isArray(listed.body?.data?.events) ? listed.body.data.events : [];
  for (const event of events) {
    if (!String(event?.title || "").startsWith(config.titlePrefix)) {
      continue;
    }
    try {
      await apiRequest(config, "DELETE", buildEventRoute(config, event.id, { scope: "series" }));
    } catch {
      // keep cleanup best-effort
    }
  }
}

function buildQuery(input = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
