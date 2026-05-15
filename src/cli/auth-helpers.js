import { readFile } from "node:fs/promises";
import { main as runCookieBootstrap } from "../../scripts/bootstrap-proton-cookies.mjs";
import { DEFAULT_PROTON_APP_VERSION } from "../constants.js";
import { assertSafeSecretFile } from "../secret-file-safety.js";
import { parseMaybeJson, readRetryAfterDetails } from "./api-client.js";
import { DEFAULT_TIMEOUT_MS } from "./constants.js";
import { flattenBundleCookies, getSetCookieHeaders, parseCookieHeader } from "./cookies.js";
import { CliError, sanitizeUpstreamPayload } from "./errors.js";

export async function runBootstrapScript(bootstrapArgs) {
  try {
    await runCookieBootstrap(bootstrapArgs);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("LOGIN_FAILED", error?.message || "Cookie bootstrap failed");
  }
}


export async function readCookieBundle(cookieBundlePath) {
  try {
    await assertSafeSecretFile(cookieBundlePath, {
      createError: (message, details) => new CliError("SECRET_FILE_UNSAFE_PERMISSIONS", message, details),
    });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("LOGIN_FAILED", `Cookie bundle file not found: ${cookieBundlePath}`);
  }

  let content;
  try {
    content = await readFile(cookieBundlePath, "utf8");
  } catch {
    throw new CliError("LOGIN_FAILED", `Cookie bundle file not found: ${cookieBundlePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError("LOGIN_FAILED", `Cookie bundle is not valid JSON: ${cookieBundlePath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("LOGIN_FAILED", `Cookie bundle must be a JSON object: ${cookieBundlePath}`);
  }

  return parsed;
}


export function readUidCandidates(bundle) {
  const candidates = Array.isArray(bundle?.uidCandidates) ? bundle.uidCandidates : [];
  return candidates.filter((value) => typeof value === "string" && value.length > 0);
}


export async function probeWorkingUid(input) {
  for (const uid of input.uidCandidates) {
    for (const protonBaseUrl of input.protonHosts) {
      try {
        await requestProtonJson(input.fetchImpl, {
          protonBaseUrl,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
          method: "GET",
          pathname: "/api/calendar/v1",
        });
        return {
          uid,
          protonBaseUrl,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}


export async function readAuthDiagnostics(sessionStore) {
  if (typeof sessionStore.getAuthCookieDiagnostics !== "function") {
    return [];
  }

  const rows = await sessionStore.getAuthCookieDiagnostics();
  return rows.map((row) => ({
    ...row,
    expiresAtIso:
      typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt)
        ? new Date(row.expiresAt).toISOString()
        : null,
  }));
}


export async function findWorkingUid(input) {
  for (const uid of input.uidCandidates) {
    for (const protonBaseUrl of input.protonHosts) {
      try {
        await requestProtonJson(input.fetchImpl, {
          protonBaseUrl,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
          method: "GET",
          pathname: "/api/calendar/v1",
        });
        return { uid, protonBaseUrl };
      } catch (error) {
        if (error instanceof CliError && error.code !== "AUTH_EXPIRED") {
          throw error;
        }

        const refreshed = await attemptLoginRefresh({
          fetchImpl: input.fetchImpl,
          protonHosts: input.protonHosts,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
        });

        if (!refreshed) {
          if (error instanceof CliError && error.code === "AUTH_EXPIRED") {
            continue;
          }
          continue;
        }

        try {
          await requestProtonJson(input.fetchImpl, {
            protonBaseUrl,
            sessionStore: input.sessionStore,
            bundle: input.bundle,
            uid,
            method: "GET",
            pathname: "/api/calendar/v1",
          });
          return { uid, protonBaseUrl };
        } catch (error) {
          if (error instanceof CliError && error.code !== "AUTH_EXPIRED") {
            throw error;
          }
          continue;
        }
      }
    }
  }

  throw new CliError(
    "AUTH_EXPIRED",
    "Unable to authenticate with current cookies. Please run pc login again and complete sign-in."
  );
}


export async function fetchCalendarsForLogin(input) {
  for (const protonBaseUrl of input.protonHosts) {
    try {
      return await requestProtonJson(input.fetchImpl, {
        protonBaseUrl,
        sessionStore: input.sessionStore,
        bundle: input.bundle,
        uid: input.uid,
        method: "GET",
        pathname: "/api/calendar/v1",
      });
    } catch (error) {
      if (error instanceof CliError && error.code !== "AUTH_EXPIRED") {
        throw error;
      }
      continue;
    }
  }

  throw new CliError("AUTH_EXPIRED", "Authenticated session is missing calendar scope. Re-run pc login.");
}


export async function attemptLoginRefresh(input) {
  const refreshPayload = await extractRefreshPayload(input.sessionStore, input.bundle, input.uid);
  if (!refreshPayload) {
    return false;
  }

  const refreshUrls = [];
  for (const host of input.protonHosts) {
    refreshUrls.push(new URL("/api/auth/v4/refresh", host).toString());
    refreshUrls.push(new URL("/api/auth/refresh", host).toString());
  }

  for (const refreshUrl of [...new Set(refreshUrls)]) {
    const url = new URL(refreshUrl);
    const cookieHeader = await buildLoginCookieHeader(input.sessionStore, url, input.bundle, input.uid);
    if (!cookieHeader) {
      continue;
    }

    let response;
    try {
      response = await input.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.protonmail.v1+json",
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          "x-pm-appversion": DEFAULT_PROTON_APP_VERSION,
          "x-pm-locale": "en-US",
          "x-pm-uid": input.uid,
        },
        body: JSON.stringify(refreshPayload),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch {
      continue;
    }

    await applyLoginSetCookies(input.sessionStore, url, response);

    const payload = parseMaybeJson(await response.text());
    if (!response.ok) {
      continue;
    }
    if (payload && typeof payload === "object" && typeof payload.Code === "number" && ![1000, 1001].includes(payload.Code)) {
      continue;
    }

    return true;
  }

  return false;
}


export async function applyLoginSetCookies(sessionStore, url, response) {
  if (typeof sessionStore.applySetCookieHeaders !== "function") {
    return;
  }

  const setCookies = getSetCookieHeaders(response.headers);
  if (setCookies.length === 0) {
    return;
  }

  await sessionStore.applySetCookieHeaders(url.toString(), setCookies);
}


export async function extractRefreshPayload(sessionStore, bundle, uid) {
  let sourceBundle = bundle;
  if (typeof sessionStore.getBundle === "function") {
    try {
      sourceBundle = await sessionStore.getBundle();
    } catch {
      // fallback to provided bundle
    }
  }

  const cookies = flattenBundleCookies(sourceBundle);
  const refreshCookies = cookies.filter((cookie) => String(cookie?.name || "").startsWith("REFRESH-"));
  if (refreshCookies.length === 0) {
    return null;
  }

  const selected =
    refreshCookies.find((cookie) => cookie.name === `REFRESH-${uid}`) ||
    refreshCookies.find((cookie) => String(cookie.name).includes(uid)) ||
    refreshCookies[0];

  const rawValue = String(selected?.value || "");
  if (!rawValue) {
    return null;
  }

  let decoded = rawValue;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    // keep raw value
  }

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return {
    ...parsed,
    UID: typeof parsed.UID === "string" && parsed.UID.length > 0 ? parsed.UID : uid,
    ResponseType: parsed.ResponseType || "token",
    GrantType: parsed.GrantType || "refresh_token",
  };
}


export async function buildLoginCookieHeader(sessionStore, url, bundle, uid) {
  const scopedHeader = await sessionStore.getCookieHeader(url.toString());
  const scopedMap = parseCookieHeader(scopedHeader);
  const fallbackMap = new Map();

  let sourceBundle = bundle;
  if (typeof sessionStore.getBundle === "function") {
    try {
      sourceBundle = await sessionStore.getBundle();
    } catch {
      // fallback to provided bundle
    }
  }

  for (const cookie of flattenBundleCookies(sourceBundle)) {
    const name = String(cookie?.name || "");
    if (!name) {
      continue;
    }

    if (name === `AUTH-${uid}` || name === `REFRESH-${uid}` || name === "Session-Id" || name === "Tag" || name === "Domain") {
      fallbackMap.set(name, String(cookie?.value || ""));
    }
  }

  const merged = new Map([...fallbackMap, ...scopedMap]);
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}


export function buildProtonHosts(primary) {
  const hosts = [primary, "https://calendar.proton.me", "https://account.proton.me"];
  const normalized = [];
  const seen = new Set();
  for (const host of hosts) {
    if (!host) {
      continue;
    }
    let url;
    try {
      url = new URL(host);
    } catch {
      continue;
    }
    const key = `${url.protocol}//${url.host}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}


export function selectLoginCalendarConfig(calendars, options) {
  const ids = calendars
    .map((calendar) => (calendar && typeof calendar.ID === "string" ? calendar.ID : ""))
    .filter(Boolean);

  if (options.targetCalendarId) {
    assertKnownCalendarId(ids, options.targetCalendarId);
    return {
      targetCalendarId: options.targetCalendarId,
      defaultCalendarId: null,
      allowedCalendarIds: [],
    };
  }

  if (options.defaultCalendarId) {
    assertKnownCalendarId(ids, options.defaultCalendarId);
    return {
      targetCalendarId: null,
      defaultCalendarId: options.defaultCalendarId,
      allowedCalendarIds: ids,
    };
  }

  if (ids.length === 0) {
    throw new CliError("LOGIN_FAILED", "No calendars found for logged-in account");
  }

  return {
    targetCalendarId: ids[0],
    defaultCalendarId: null,
    allowedCalendarIds: [],
  };
}


export function assertKnownCalendarId(ids, calendarId) {
  if (ids.length === 0) {
    throw new CliError("LOGIN_FAILED", "No calendars found for logged-in account");
  }
  if (!ids.includes(calendarId)) {
    throw new CliError("INVALID_ARGS", `Requested calendar not found: ${calendarId}`);
  }
}


export async function requestProtonJson(fetchImpl, input) {
  const url = new URL(input.pathname, input.protonBaseUrl);
  const cookieHeader = input.bundle
    ? await buildLoginCookieHeader(input.sessionStore, url, input.bundle, input.uid)
    : await input.sessionStore.getCookieHeader(url.toString());
  if (!cookieHeader) {
    throw new CliError("AUTH_EXPIRED", "No valid Proton cookies found");
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: input.method,
      headers: {
        Accept: "application/vnd.protonmail.v1+json",
        Cookie: cookieHeader,
        "x-pm-appversion": DEFAULT_PROTON_APP_VERSION,
        "x-pm-locale": "en-US",
        "x-pm-uid": input.uid,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError("LOGIN_FAILED", "Unable to reach Proton API", {
      message: error?.message,
    });
  }

  const text = await response.text();
  const payload = parseMaybeJson(text);

  if (response.status === 429) {
    throw new CliError("RATE_LIMITED", "Proton rate limit exceeded", {
      status: 429,
      retryable: true,
      ...readRetryAfterDetails(response),
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new CliError("AUTH_EXPIRED", "Proton session is unauthorized or expired");
  }

  if (!response.ok) {
    throw new CliError("LOGIN_FAILED", "Proton request failed", {
      status: response.status,
      ...sanitizeUpstreamPayload(payload),
    });
  }

  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    if (![1000, 1001].includes(payload.Code)) {
      throw new CliError("LOGIN_FAILED", "Unexpected Proton response", sanitizeUpstreamPayload(payload));
    }
  }

  return payload;
}



