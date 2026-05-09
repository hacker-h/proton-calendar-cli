#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DEFAULT_PROTON_APP_VERSION } from "../../src/constants.js";

const DEFAULT_OUTPUT_FILE = "secrets/proton-cookies.json";
const DEFAULT_LOGIN_URL = "https://account.proton.me/login";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POST_LOGIN_TIMEOUT_MS = 120000;
const PROTON_HOSTS = ["https://calendar.proton.me", "https://account.proton.me"];

const EXIT_CODES = {
  CONFIG_MISSING: 10,
  BROWSER_SETUP: 20,
  NETWORK_TIMEOUT: 30,
  BAD_CREDENTIALS: 40,
  INTERACTIVE_CHALLENGE: 50,
  UI_DRIFT: 60,
  SESSION_INVALID: 70,
  SANITIZATION_BLOCKED: 80,
};

const ERROR_MESSAGES = {
  CONFIG_MISSING: "Required Proton CI login configuration is missing.",
  BROWSER_SETUP: "Unable to launch the CI browser for Proton login.",
  NETWORK_TIMEOUT: "Timed out while waiting for Proton login or Calendar readiness.",
  BAD_CREDENTIALS: "Proton rejected the configured credentials.",
  INTERACTIVE_CHALLENGE: "Proton requested an interactive login challenge that CI cannot complete.",
  UI_DRIFT: "Proton login UI did not match the expected CI selectors.",
  SESSION_INVALID: "The exported Proton browser session did not pass validation.",
  SANITIZATION_BLOCKED: "Bootstrap diagnostics failed the sanitizer.",
};

async function main() {
  let options;
  let browser;
  let context;
  let page;

  try {
    options = parseArgs(process.argv.slice(2), process.env);
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    }).catch((error) => {
      throw new BootstrapError("BROWSER_SETUP", "launch", {}, error);
    });

    context = await browser.newContext({
      ignoreHTTPSErrors: false,
      viewport: { width: 1440, height: 1100 },
    });
    page = await context.newPage();

    await loginWithPassword(page, options);
    await waitForAuthenticatedCalendar(page, options.postLoginTimeoutMs);

    const payload = await exportBundle(context, page, options);
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(options.outputFile, 0o600);

    const summary = sanitizeSuccessSummary(payload, options);
    assertSafeDiagnostics(summary);
    console.log(JSON.stringify({ data: summary }, null, 2));
  } catch (error) {
    handleFatalError(error, page);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

function parseArgs(argv, env) {
  const options = {
    outputFile: path.resolve(env.COOKIE_BUNDLE_PATH || DEFAULT_OUTPUT_FILE),
    loginUrl: env.PROTON_LOGIN_URL || DEFAULT_LOGIN_URL,
    username: String(env.PROTON_USERNAME || "").trim(),
    password: String(env.PROTON_PASSWORD || "").trim(),
    timeoutMs: readPositiveNumber(env.PROTON_LOGIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    postLoginTimeoutMs: readPositiveNumber(env.PROTON_POST_LOGIN_TIMEOUT_MS, DEFAULT_POST_LOGIN_TIMEOUT_MS),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === "--output" && next) {
      options.outputFile = path.resolve(next);
      i += 1;
      continue;
    }
    if (token === "--login-url" && next) {
      options.loginUrl = next;
      i += 1;
      continue;
    }
    if (token === "--timeout-ms" && next) {
      options.timeoutMs = readPositiveNumber(next, DEFAULT_TIMEOUT_MS);
      i += 1;
      continue;
    }
    if (token === "--post-login-timeout-ms" && next) {
      options.postLoginTimeoutMs = readPositiveNumber(next, DEFAULT_POST_LOGIN_TIMEOUT_MS);
      i += 1;
      continue;
    }
  }

  if (!options.username) {
    throw new BootstrapError("CONFIG_MISSING", "config", { missing: "PROTON_USERNAME" });
  }
  if (!options.password) {
    throw new BootstrapError("CONFIG_MISSING", "config", { missing: "PROTON_PASSWORD" });
  }

  return options;
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loginWithPassword(page, options) {
  await page.goto(options.loginUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });

  await dismissCookieBanner(page);
  await fillFirstVisible(page, USERNAME_SELECTORS, options.username, options.timeoutMs);
  await fillFirstVisible(page, PASSWORD_SELECTORS, options.password, options.timeoutMs);
  await clickFirstVisible(page, SUBMIT_SELECTORS, options.timeoutMs);
}

async function waitForAuthenticatedCalendar(page, timeoutMs) {
  await waitForLoggedInLanding(page, Math.min(timeoutMs, 45000));

  if (/https:\/\/account\.proton\.me\/apps/.test(page.url())) {
    await openCalendarAppIfAvailable(page, timeoutMs);
  } else if (!/https:\/\/calendar\.proton\.me\//.test(page.url())) {
    await page.goto("https://calendar.proton.me/u/0", { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 30000) });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await hasPersistedCalendarSession(page)) && (await isAnyVisible(page, CALENDAR_READY_SELECTORS))) {
      return;
    }

    const challenge = await detectChallenge(page);
    if (challenge) {
      throw new BootstrapError("INTERACTIVE_CHALLENGE", "calendar-ready", { challenge });
    }

    const errorText = await readFirstVisibleText(page, LOGIN_ERROR_SELECTORS);
    if (errorText) {
      throw classifyLoginError(errorText, "calendar-ready");
    }

    await page.waitForTimeout(2000);
  }

  throw new BootstrapError("NETWORK_TIMEOUT", "calendar-ready", { url: safePageUrlSummary(page) });
}

async function waitForLoggedInLanding(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();

    if (/https:\/\/account\.proton\.me\/apps/.test(url) || /https:\/\/calendar\.proton\.me\//.test(url)) {
      return;
    }

    const challenge = await detectChallenge(page);
    if (challenge) {
      throw new BootstrapError("INTERACTIVE_CHALLENGE", "login-landing", { challenge });
    }

    const errorText = await readFirstVisibleText(page, LOGIN_ERROR_SELECTORS);
    if (errorText) {
      throw classifyLoginError(errorText, "login-landing");
    }

    await page.waitForTimeout(1000);
  }

  throw new BootstrapError("NETWORK_TIMEOUT", "login-landing", { url: safePageUrlSummary(page) });
}

async function openCalendarAppIfAvailable(page, timeoutMs) {
  const calendarLink = page.locator('a[href^="https://calendar.proton.me/u/"]').first();
  if (!(await calendarLink.isVisible().catch(() => false))) {
    return false;
  }

  const href = await calendarLink.getAttribute("href");
  if (!href) {
    return false;
  }

  await page.goto(href, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 30000) });
  return true;
}

async function hasPersistedCalendarSession(page) {
  try {
    const keys = await page.evaluate(() => Object.keys(window.localStorage || {}));
    return keys.some((key) => key.startsWith("ps-"));
  } catch {
    return false;
  }
}

async function exportBundle(context, page, options) {
  const cookies = await collectCookies(context, page);
  const cookiesByDomain = groupCookiesByDomain(cookies);
  const persistedSessions = await collectPersistedSessions(page);
  const uidCandidates = extractUidCandidates(cookies, persistedSessions);
  const authProbe = await verifyCalendarApiSession(page, uidCandidates);

  if (!authProbe) {
    throw new BootstrapError("SESSION_INVALID", "auth-probe", {
      uidCandidateCount: uidCandidates.length,
      persistedSessionCount: Object.keys(persistedSessions).length,
      cookieCount: cookies.length,
    });
  }

  return {
    exportedAt: new Date().toISOString(),
    source: "playwright-ci",
    loginUrl: options.loginUrl,
    domains: PROTON_HOSTS.map((host) => new URL(host).hostname),
    cookies,
    cookiesByDomain,
    uidCandidates,
    persistedSessions,
    authProbe,
  };
}

async function collectCookies(context, page) {
  const cookiesFromContext = await context.cookies(PROTON_HOSTS);
  const cookiesFromCdp = await collectCookiesViaCdp(page).catch(() => []);
  const deduped = new Map();

  for (const cookie of [...cookiesFromContext, ...cookiesFromCdp]) {
    const normalized = normalizeCookie(cookie);
    if (!normalized || !normalized.name || !normalized.value || !matchesProtonHost(normalized.domain)) {
      continue;
    }
    deduped.set(`${normalized.domain}|${normalized.path}|${normalized.name}`, normalized);
  }

  return [...deduped.values()].sort((a, b) => `${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));
}

async function collectCookiesViaCdp(page) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Network.enable");
    const result = await client.send("Network.getAllCookies");
    return Array.isArray(result?.cookies) ? result.cookies : [];
  } finally {
    await client.detach().catch(() => {});
  }
}

function matchesProtonHost(domain) {
  const normalized = String(domain || "").replace(/^\./, "").toLowerCase();
  return ["proton.me", "account.proton.me", "calendar.proton.me", "account-api.proton.me"].some(
    (host) => normalized === host || normalized.endsWith(`.${host}`)
  );
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== "object") {
    return null;
  }

  const domain = String(cookie.domain || "").replace(/^\./, "").trim().toLowerCase();
  if (!domain) {
    return null;
  }

  const payload = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };

  if (cookie.sameSite && cookie.sameSite !== "None") {
    payload.sameSite = cookie.sameSite;
  } else if (cookie.sameSite === "None") {
    payload.sameSite = "None";
  }

  if (typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0) {
    payload.expires = Math.floor(cookie.expires);
  }

  return payload;
}

function groupCookiesByDomain(cookies) {
  const grouped = {};
  for (const cookie of cookies) {
    if (!grouped[cookie.domain]) {
      grouped[cookie.domain] = [];
    }
    grouped[cookie.domain].push(cookie);
  }
  return grouped;
}

function extractUidCandidates(cookies, persistedSessions = {}) {
  const values = new Set();
  for (const cookie of cookies) {
    const name = String(cookie?.name || "");
    if (name.startsWith("AUTH-")) {
      values.add(name.slice("AUTH-".length));
    }
    if (name.startsWith("REFRESH-")) {
      values.add(name.slice("REFRESH-".length));
    }
  }

  for (const session of Object.values(persistedSessions || {})) {
    const uid = String(session?.UID || "").trim();
    if (uid) {
      values.add(uid);
    }
  }

  return [...values];
}

async function collectPersistedSessions(page) {
  const results = {};
  for (const url of ["https://calendar.proton.me/u/0", "https://account.proton.me/apps", "https://account.proton.me/u/0"]) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(5000);
      await waitForStoragePopulation(page, 10000);
      const entries = await page.evaluate(() => {
        return Object.entries(window.localStorage || {}).map(([key, value]) => ({ key, value }));
      });
      for (const entry of entries) {
        const key = String(entry?.key || "");
        const rawValue = entry?.value;
        if (!key || typeof rawValue !== "string") {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        if (typeof parsed.blob === "string" && parsed.blob.length > 0) {
          results[key] = parsed;
        }
      }
    } catch {
      continue;
    }
  }
  return results;
}

async function waitForStoragePopulation(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => Object.keys(window.localStorage || {}).length).catch(() => 0);
    if (count > 0) {
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function verifyCalendarApiSession(page, uidCandidates) {
  await page.goto("https://calendar.proton.me/u/0", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(12000);
  await waitForStoragePopulation(page, 10000);

  const localStorageUids = await page.evaluate(() => {
    const values = new Set();
    for (const [key, rawValue] of Object.entries(window.localStorage || {})) {
      if (!key.startsWith("ps-")) {
        continue;
      }
      try {
        const parsed = JSON.parse(rawValue);
        const uid = String(parsed?.UID || "").trim();
        if (uid) {
          values.add(uid);
        }
      } catch {
        // ignore malformed storage entries
      }
    }
    return [...values];
  }).catch(() => []);

  const candidates = [...new Set([...(uidCandidates || []), ...localStorageUids])];

  for (const uid of candidates) {
    try {
      const payload = await page.evaluate(async ({ candidateUid, appVersion }) => {
        const response = await fetch("/api/calendar/v1", {
          method: "GET",
          headers: {
            Accept: "application/vnd.protonmail.v1+json",
            "x-pm-appversion": appVersion,
            "x-pm-locale": "en-US",
            "x-pm-uid": candidateUid,
          },
          credentials: "include",
        });

        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }

        return {
          ok: response.ok,
          status: response.status,
          body,
        };
      }, { candidateUid: uid, appVersion: DEFAULT_PROTON_APP_VERSION });

      const calendars = Array.isArray(payload?.body?.Calendars) ? payload.body.Calendars : [];
      if (payload?.ok && [1000, 1001].includes(payload?.body?.Code) && calendars.length > 0) {
        return {
          uid,
          host: "https://calendar.proton.me",
          calendarCount: calendars.length,
          defaultCalendarId: String(calendars[0]?.ID || "") || null,
          calendarIds: calendars
            .map((calendar) => String(calendar?.ID || "").trim())
            .filter(Boolean),
        };
      }
    } catch {
      // try next UID
    }
  }
  return null;
}

function isAuthenticatedCalendarUrl(url) {
  return (
    typeof url === "string" &&
    ((/https:\/\/calendar\.proton\.me\/(u\/\d+)?/.test(url) && !/\/login/.test(url)) ||
      (/https:\/\/account\.proton\.me\/(calendar|apps)/.test(url) && !/\/login/.test(url)))
  );
}

async function dismissCookieBanner(page) {
  await clickFirstVisible(page, COOKIE_BANNER_SELECTORS, 3000, false);
}

async function fillFirstVisible(page, selectors, value, timeoutMs) {
  const handle = await waitForFirstVisible(page, selectors, timeoutMs);
  await handle.fill("");
  await handle.fill(value);
}

async function clickFirstVisible(page, selectors, timeoutMs, required = true) {
  const handle = await waitForFirstVisible(page, selectors, timeoutMs, required);
  if (!handle) {
    return false;
  }
  await handle.click();
  return true;
}

async function waitForFirstVisible(page, selectors, timeoutMs, required = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    await page.waitForTimeout(250);
  }

  if (required) {
    throw new BootstrapError("UI_DRIFT", "selector", { selectorCount: selectors.length });
  }
  return null;
}

async function isAnyVisible(page, selectors) {
  for (const selector of selectors) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      return true;
    }
  }
  return false;
}

async function readFirstVisibleText(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      const text = await locator.textContent().catch(() => "");
      if (text && text.trim()) {
        return text.trim();
      }
    }
  }
  return "";
}

class BootstrapError extends Error {
  constructor(code, phase, details = {}, cause = null) {
    super(ERROR_MESSAGES[code] || "Proton CI bootstrap failed.");
    this.name = "BootstrapError";
    this.code = code;
    this.phase = phase;
    this.details = details;
    this.exitCode = EXIT_CODES[code] || 1;
    if (cause) {
      this.cause = cause;
    }
  }
}

function classifyLoginError(text, phase) {
  const normalized = String(text || "").toLowerCase();
  if (/incorrect|invalid|wrong|credential|password|username/.test(normalized)) {
    return new BootstrapError("BAD_CREDENTIALS", phase);
  }
  if (/locked|disabled|suspended/.test(normalized)) {
    return new BootstrapError("INTERACTIVE_CHALLENGE", phase, { challenge: "account_locked" });
  }
  if (/rate|too many|try again later/.test(normalized)) {
    return new BootstrapError("INTERACTIVE_CHALLENGE", phase, { challenge: "rate_limited" });
  }
  return new BootstrapError("UI_DRIFT", phase);
}

async function detectChallenge(page) {
  for (const [challenge, selectors] of Object.entries(CHALLENGE_SELECTORS)) {
    if (await isAnyVisible(page, selectors)) {
      return challenge;
    }
  }
  return "";
}

function sanitizeSuccessSummary(payload, options) {
  const cookieNames = [...new Set((payload.cookies || []).map((cookie) => sanitizeCookieName(cookie.name)).filter(Boolean))].sort();
  return {
    outputFile: options.outputFile,
    source: payload.source,
    loginUrl: safeUrlSummary(payload.loginUrl),
    cookieCount: payload.cookies.length,
    cookieNames,
    uidCandidateCount: payload.uidCandidates.length,
    persistedSessionCount: Object.keys(payload.persistedSessions || {}).length,
    authProbe: payload.authProbe
      ? {
          host: safeUrlSummary(payload.authProbe.host),
          calendarCount: payload.authProbe.calendarCount,
        }
      : null,
  };
}

function handleFatalError(error, page = null) {
  const failure = normalizeBootstrapError(error);
  const details = sanitizeDetails({
    ...failure.details,
    phase: failure.phase,
    url: page ? safePageUrlSummary(page) : failure.details?.url,
  });

  const payload = {
    error: {
      code: failure.code,
      message: failure.message,
      details,
    },
  };

  try {
    assertSafeDiagnostics(payload);
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = failure.exitCode;
  } catch {
    console.error(JSON.stringify({
      error: {
        code: "SANITIZATION_BLOCKED",
        message: ERROR_MESSAGES.SANITIZATION_BLOCKED,
        details: { phase: "diagnostics" },
      },
    }, null, 2));
    process.exitCode = EXIT_CODES.SANITIZATION_BLOCKED;
  }
}

function normalizeBootstrapError(error) {
  if (error instanceof BootstrapError) {
    return error;
  }
  const message = String(error?.message || "").toLowerCase();
  if (/timeout|timed out/.test(message)) {
    return new BootstrapError("NETWORK_TIMEOUT", "unknown");
  }
  if (/browser|chromium|executable/.test(message)) {
    return new BootstrapError("BROWSER_SETUP", "launch");
  }
  return new BootstrapError("UI_DRIFT", "unknown");
}

function safePageUrlSummary(page) {
  try {
    return safeUrlSummary(page?.url());
  } catch {
    return null;
  }
}

function safeUrlSummary(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (!matchesProtonHost(host)) {
      return { host: "external", path: "/" };
    }
    return { host, path: url.pathname || "/" };
  } catch {
    return null;
  }
}

function sanitizeCookieName(name) {
  return String(name || "")
    .replace(/^(AUTH|REFRESH)-.+$/i, "$1-<redacted>")
    .replace(/^(UID)-.+$/i, "$1-<redacted>");
}

function sanitizeDetails(details) {
  const safe = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (["missing", "challenge", "phase", "url", "uidCandidateCount", "persistedSessionCount", "cookieCount", "selectorCount"].includes(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

function assertSafeDiagnostics(value) {
  const serialized = JSON.stringify(value);
  if (/AUTH-[A-Za-z0-9_-]+|REFRESH-[A-Za-z0-9_-]+|UID":|blob":|"cookie"\s*:\s*\{[^}]*"value"/i.test(serialized)) {
    throw new BootstrapError("SANITIZATION_BLOCKED", "diagnostics");
  }
}

const USERNAME_SELECTORS = [
  'input[name="username"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[autocomplete="username"]',
  'input[id*="username"]',
];

const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[type="password"]',
  'input[autocomplete="current-password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
  'button:has-text("Continue")',
];

const COOKIE_BANNER_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("Allow all")',
  'button:has-text("I agree")',
];

const CHALLENGE_SELECTORS = {
  mfa: [
    'input[name="totp"]',
    'input[autocomplete="one-time-code"]',
    'text=/two-factor|2-factor|one-time code|security code/i',
  ],
  captcha: [
    'iframe[src*="captcha"]',
    'text=/captcha|human verification|verify you are human/i',
  ],
  email_code: [
    'text=/email code|verification code sent|check your email/i',
  ],
  account_locked: [
    'text=/account locked|account disabled|account suspended/i',
  ],
  rate_limited: [
    'text=/rate limit|too many attempts|try again later/i',
  ],
};

const LOGIN_ERROR_SELECTORS = [
  '[role="alert"]',
  '[data-testid*="error"]',
  'text=/incorrect|invalid|failed|try again/i',
];

const CALENDAR_READY_SELECTORS = [
  '[data-testid*="calendar"]',
  'text=/Today|Week|Month|Agenda/',
  'button:has-text("Today")',
];

export {
  BootstrapError,
  assertSafeDiagnostics,
  classifyLoginError,
  normalizeBootstrapError,
  parseArgs,
  safeUrlSummary,
  sanitizeSuccessSummary,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
