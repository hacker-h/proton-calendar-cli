import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function readLiveConfig(env = process.env) {
  const apiBaseUrl = String(env.PC_API_BASE_URL || env.API_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
  const apiToken = String(env.PC_API_TOKEN || env.API_BEARER_TOKEN || "").trim();
  const calendarId = String(env.PROTON_TEST_CALENDAR_ID || env.TARGET_CALENDAR_ID || env.DEFAULT_CALENDAR_ID || "").trim() || null;
  const enabled = Boolean(apiBaseUrl && apiToken);
  const capabilities = readLiveCapabilities(env);

  return {
    enabled,
    apiBaseUrl,
    apiToken,
    calendarId,
    capabilities,
    titlePrefix: env.PROTON_TEST_TITLE_PREFIX || `ci-e2e-${randomUUID().slice(0, 8)}`,
  };
}

export function readLiveCapabilities(env = process.env) {
  const plan = normalizeLivePlan(env.PROTON_LIVE_PLAN);
  const hasSecondAccount = Boolean(String(env.PROTON_USERNAME2 || "").trim() && String(env.PROTON_PASSWORD2 || "").trim());
  const secondAccountRequested = readBooleanFlag(env.PROTON_LIVE_ENABLE_SECOND_ACCOUNT);
  const secondAccount = secondAccountRequested && hasSecondAccount;
  const invitesRequested = readBooleanFlag(env.PROTON_LIVE_ENABLE_INVITES);

  return {
    plan,
    calendarCrud: readBooleanFlag(env.PROTON_LIVE_ENABLE_CALENDAR_CRUD),
    sharing: readBooleanFlag(env.PROTON_LIVE_ENABLE_SHARING),
    invites: invitesRequested && secondAccount,
    invitesRequested,
    conferencingMetadata: readBooleanFlag(env.PROTON_LIVE_ENABLE_CONFERENCING_METADATA),
    protonMeet: readBooleanFlag(env.PROTON_LIVE_ENABLE_PROTON_MEET),
    zoom: readBooleanFlag(env.PROTON_LIVE_ENABLE_ZOOM),
    availability: readBooleanFlag(env.PROTON_LIVE_ENABLE_AVAILABILITY),
    appointmentScheduling: readBooleanFlag(env.PROTON_LIVE_ENABLE_APPOINTMENT_SCHEDULING),
    subscribedCalendars: readBooleanFlag(env.PROTON_LIVE_ENABLE_SUBSCRIBED_CALENDARS),
    holidayCalendars: readBooleanFlag(env.PROTON_LIVE_ENABLE_HOLIDAY_CALENDARS),
    birthdayCalendars: readBooleanFlag(env.PROTON_LIVE_ENABLE_BIRTHDAY_CALENDARS),
    secondAccount,
    secondAccountRequested,
    hasSecondAccount,
    attendeeEmail: String(env.PROTON_LIVE_ATTENDEE_EMAIL || env.PROTON_USERNAME2 || "").trim() || null,
  };
}

export function skipUnlessCapability(config, capability, options = {}) {
  const capabilities = config?.capabilities || readLiveCapabilities();
  if (capabilities[capability] === true) {
    return false;
  }
  if (capability === "secondAccount" && capabilities.secondAccountRequested && !capabilities.hasSecondAccount) {
    return "second-account live tests require PROTON_USERNAME2 and PROTON_PASSWORD2";
  }
  if (capability === "invites" && capabilities.invitesRequested && !capabilities.secondAccount) {
    return "invite live tests require PROTON_LIVE_ENABLE_SECOND_ACCOUNT=1 with PROTON_USERNAME2 and PROTON_PASSWORD2";
  }
  return options.reason || `${capability} live tests are disabled by capability gate`;
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

function readBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function normalizeLivePlan(value) {
  const plan = String(value || "free").trim().toLowerCase();
  return ["free", "paid", "org"].includes(plan) ? plan : "free";
}
