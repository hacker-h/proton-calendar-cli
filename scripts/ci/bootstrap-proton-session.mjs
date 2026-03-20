#!/usr/bin/env node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_OUTPUT_FILE = "secrets/proton-cookies.json";
const DEFAULT_LOGIN_URL = "https://account.proton.me/login";
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_POST_LOGIN_TIMEOUT_MS = 120000;
const PROTON_HOSTS = ["https://calendar.proton.me", "https://account.proton.me"];

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();

  try {
    await loginWithPassword(page, options);
    await waitForAuthenticatedCalendar(page, options.postLoginTimeoutMs);

    const payload = await exportBundle(context, page, options);
    await mkdir(path.dirname(options.outputFile), { recursive: true });
    await writeFile(options.outputFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(options.outputFile, 0o600);

    console.log(JSON.stringify({
      data: {
        outputFile: options.outputFile,
        uidCandidates: payload.uidCandidates,
        authProbe: payload.authProbe,
        defaultCalendarId: payload.authProbe?.defaultCalendarId || null,
        cookieCount: payload.cookies.length,
        persistedSessionCount: Object.keys(payload.persistedSessions || {}).length,
      },
    }, null, 2));
  } finally {
    await context.close();
    await browser.close();
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
    throw new Error("PROTON_USERNAME is required");
  }
  if (!options.password) {
    throw new Error("PROTON_PASSWORD is required");
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

    const challengeVisible = await isAnyVisible(page, MFA_SELECTORS);
    if (challengeVisible) {
      throw new Error("Proton requested additional verification; CI needs password-only login for this account");
    }

    const errorText = await readFirstVisibleText(page, LOGIN_ERROR_SELECTORS);
    if (errorText) {
      throw new Error(`Proton login failed: ${errorText}`);
    }

    await page.waitForTimeout(2000);
  }

  throw new Error(`Timed out waiting for authenticated Proton Calendar session (last URL: ${page.url() || "unknown"})`);
}

async function waitForLoggedInLanding(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();

    if (/https:\/\/account\.proton\.me\/apps/.test(url) || /https:\/\/calendar\.proton\.me\//.test(url)) {
      return;
    }

    const challengeVisible = await isAnyVisible(page, MFA_SELECTORS);
    if (challengeVisible) {
      throw new Error("Proton requested additional verification; CI needs password-only login for this account");
    }

    const errorText = await readFirstVisibleText(page, LOGIN_ERROR_SELECTORS);
    if (errorText) {
      throw new Error(`Proton login failed: ${errorText}`);
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for Proton login landing page (last URL: ${page.url() || "unknown"})`);
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
    throw new Error(
      `Authenticated browser session did not pass Proton Calendar API probe (uidCandidates=${uidCandidates.length}, persistedSessions=${Object.keys(persistedSessions).length}, cookies=${cookies.length})`
    );
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
      const payload = await page.evaluate(async (candidateUid) => {
        const response = await fetch("/api/calendar/v1", {
          method: "GET",
          headers: {
            Accept: "application/vnd.protonmail.v1+json",
            "x-pm-appversion": "web-calendar@5.0.101.3",
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
      }, uid);

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
    throw new Error(`Unable to find visible Proton login element: ${selectors.join(", ")}`);
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

const MFA_SELECTORS = [
  'input[name="totp"]',
  'input[autocomplete="one-time-code"]',
  'text=/two-factor|2-factor|one-time code|security code/i',
];

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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
