#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCookies } from "@steipete/sweet-cookie";
import {
  DEFAULT_PROTON_DOMAINS,
  countAuthCookies,
  fetchDevtoolsTargets,
  fileExists,
  findAvailablePort,
  flattenCookies,
  looksAuthenticated,
} from "../src/proton-cookie-bootstrap.js";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_SECONDS = 3;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromePath = options.chromePath || defaultChromePath();

  if (!chromePath || !(await fileExists(chromePath))) {
    throw new Error(
      "Chrome not found. Set --chrome-path or CHROME_PATH to your Chrome executable path."
    );
  }

  const profileDir = options.profileDir || (await mkdtemp(path.join(os.tmpdir(), "proton-cookie-profile-")));
  await mkdir(profileDir, { recursive: true });

  const devtoolsPort = await findAvailablePort();
  const loginUrl = options.loginUrl || "https://calendar.proton.me/u/0";
  const outputFile = path.resolve(options.outputFile || "secrets/proton-cookies.json");

  console.log("Opening Chrome for manual Proton login...");
  console.log(`- URL: ${loginUrl}`);
  console.log(`- Chrome: ${chromePath}`);
  console.log(`- Profile: ${profileDir}`);
  console.log(`- DevTools: http://127.0.0.1:${devtoolsPort}`);

  const chrome = launchChrome(chromePath, profileDir, devtoolsPort, loginUrl, options.headless);
  let completed = false;

  try {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutSeconds * 1000;
    let warnedExportFailure = false;

    while (Date.now() - startedAt < timeoutMs) {
      let cookiesByDomain = {};
      let extractor = "";
      try {
        const exported = await exportCookies(profileDir, devtoolsPort, DEFAULT_PROTON_DOMAINS);
        cookiesByDomain = exported.cookiesByDomain;
        extractor = exported.extractor;
        warnedExportFailure = false;
      } catch {
        if (!warnedExportFailure) {
          console.log("Waiting for cookie export access (check keychain/system prompts)...");
          warnedExportFailure = true;
        }
      }

      const authCookieCount = countAuthCookies(cookiesByDomain);
      const uidCandidates = extractUidCandidates(cookiesByDomain);
      if (authCookieCount > 0 && warnedExportFailure) {
        warnedExportFailure = false;
      }

      const targets = await fetchDevtoolsTargets(devtoolsPort).catch(() => []);
      const readyByCookiesOnly = authCookieCount >= 2 && uidCandidates.length > 0;
      const likelyAuthenticated = readyByCookiesOnly || looksAuthenticated(cookiesByDomain, targets);

      if (likelyAuthenticated) {
        const authProbe = await verifyCalendarApiSession(cookiesByDomain, uidCandidates).catch(() => null);
        if (!authProbe) {
          await delay(options.pollSeconds * 1000);
          continue;
        }

        const persistedSessions = await exportPersistedSessionsWithDevTools(devtoolsPort).catch(() => ({}));
        const payload = {
          exportedAt: new Date().toISOString(),
          source: extractor || "unknown",
          loginUrl,
          domains: DEFAULT_PROTON_DOMAINS,
          cookiesByDomain,
          cookies: flattenCookies(cookiesByDomain),
          uidCandidates,
          persistedSessions,
          authProbe,
        };

        await mkdir(path.dirname(outputFile), { recursive: true });
        await writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        await chmod(outputFile, 0o600);

        console.log("\nLogin detected and cookies exported.");
        console.log(`- Output: ${outputFile}`);
        console.log(`- Cookies: ${payload.cookies.length}`);
        completed = true;
        break;
      }

      await delay(options.pollSeconds * 1000);
    }

    if (!completed) {
      throw new Error(
        "Timed out waiting for Proton login. Complete login in the opened Chrome window, then retry."
      );
    }
  } finally {
    await shutdownChrome(chrome);
    if (!options.keepProfile && !options.profileDir) {
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    pollSeconds: DEFAULT_POLL_SECONDS,
    keepProfile: false,
    outputFile: "secrets/proton-cookies.json",
    loginUrl: "https://calendar.proton.me/u/0",
    profileDir: "",
    chromePath: process.env.CHROME_PATH || "",
    headless: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--timeout" && next) {
      options.timeoutSeconds = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--poll" && next) {
      options.pollSeconds = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--output" && next) {
      options.outputFile = next;
      i += 1;
      continue;
    }
    if (arg === "--profile-dir" && next) {
      options.profileDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--chrome-path" && next) {
      options.chromePath = next;
      i += 1;
      continue;
    }
    if (arg === "--login-url" && next) {
      options.loginUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--keep-profile") {
      options.keepProfile = true;
      continue;
    }
    if (arg === "--headless") {
      options.headless = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) {
    throw new Error("--poll must be a positive number of seconds");
  }

  return options;
}

function printHelp() {
  console.log(`Manual Proton login + SweetLink cookie export\n
Usage:
  pnpm run bootstrap:cookies -- [options]

Options:
  --timeout <seconds>     Max wait time for login detection (default: 600)
  --poll <seconds>        Poll interval for login detection (default: 3)
  --output <path>         Export file path (default: secrets/proton-cookies.json)
  --profile-dir <path>    Reuse an existing Chrome profile directory
  --keep-profile          Keep temp profile directory after export
  --headless              Launch Chrome headlessly for recovery attempts
  --chrome-path <path>    Chrome executable path
  --login-url <url>       URL to open for login (default: https://calendar.proton.me/u/0)
`);
}

function defaultChromePath() {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  return "/usr/bin/google-chrome";
}

function launchChrome(chromePath, profileDir, devtoolsPort, loginUrl, headless = false) {
  const args = [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-insecure-localhost",
    loginUrl,
  ];

  if (headless) {
    args.splice(2, 0, "--headless=new");
  } else {
    args.splice(2, 0, "--new-window");
  }

  const child = spawn(chromePath, args, {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });

  child.unref();
  return child;
}

async function exportCookies(profileDir, devtoolsPort, domains) {
  try {
    return {
      extractor: "sweet-cookie",
      cookiesByDomain: await exportCookiesWithSweetCookie(profileDir, domains),
    };
  } catch {
    // continue fallback chain
  }

  try {
    return {
      extractor: "devtools",
      cookiesByDomain: await exportCookiesWithDevTools(devtoolsPort, domains),
    };
  } catch {
    // continue fallback chain
  }

  throw new Error("Unable to export Proton cookies with sweet-cookie or DevTools");
}

async function exportCookiesWithSweetCookie(profileDir, domains) {
  const chromeProfilePath = await resolveSweetLinkProfilePath(profileDir);
  const keychainPassword = await readChromeSafeStoragePassword();
  if (keychainPassword) {
    process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = keychainPassword;
  }

  const grouped = {};
  for (const domain of domains) {
    const key = String(domain).trim().toLowerCase();
    const seen = new Set();

    const sweet = await getCookies({
      url: `https://${key}/api/auth/refresh`,
      browsers: ["chrome"],
      chromeProfile: chromeProfilePath,
      mode: "first",
      timeoutMs: 3000,
      includeExpired: false,
    });

    grouped[key] = [];
    for (const cookie of sweet.cookies || []) {
      if (!cookieMatchesDomain(cookie.domain, key)) {
        continue;
      }
      const normalized = normalizeSweetCookie(cookie);
      if (!normalized) {
        continue;
      }
      const dedupeKey = `${normalized.domain}|${normalized.path}|${normalized.name}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      grouped[key].push(normalized);
    }
  }

  const totalCookies = Object.values(grouped).reduce((sum, item) => sum + item.length, 0);
  if (totalCookies === 0) {
    throw new Error("sweet-cookie returned no cookies for Proton domains");
  }

  return grouped;
}

async function exportCookiesWithDevTools(devtoolsPort, domains) {
  if (typeof WebSocket !== "function") {
    throw new Error("WebSocket is not available in this Node runtime");
  }

  const websocketUrl = await openDevToolsTarget(devtoolsPort, "https://calendar.proton.me/u/0");
  if (!websocketUrl) {
    throw new Error("No DevTools websocket target available");
  }

  const client = await createCdpClient(websocketUrl);
  try {
    await client.send("Network.enable");
    const result = await client.send("Network.getAllCookies");
    const allCookies = Array.isArray(result?.cookies) ? result.cookies : [];

    const normalized = allCookies
      .map((cookie) => normalizeDevToolsCookie(cookie))
      .filter((cookie) => cookie && typeof cookie.domain === "string");

    const grouped = {};
    for (const domain of domains) {
      const key = String(domain).trim().toLowerCase();
      const seen = new Set();
      grouped[key] = [];

      for (const cookie of normalized) {
        if (!cookieMatchesDomain(cookie.domain, key)) {
          continue;
        }
        const dedupeKey = `${cookie.domain}|${cookie.path}|${cookie.name}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        grouped[key].push(cookie);
      }
    }

    return grouped;
  } finally {
    await client.close();
  }
}

async function exportPersistedSessionsWithDevTools(devtoolsPort) {
  if (typeof WebSocket !== "function") {
    return {};
  }

  const origins = ["https://calendar.proton.me/u/0", "https://account.proton.me/u/0"];
  const websocketUrl = await openDevToolsTarget(devtoolsPort, origins[0]);
  if (!websocketUrl) {
    return {};
  }

  const client = await createCdpClient(websocketUrl);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const sessions = {};
    for (let attempt = 0; attempt < 6; attempt += 1) {
      for (const origin of origins) {
        await client.send("Page.navigate", { url: origin });
        await delay(1200 + attempt * 250);

        const result = await client.send("Runtime.evaluate", {
          expression:
            "JSON.stringify(Object.entries(localStorage || {}).map(([key, value]) => ({ key, value })))",
          returnByValue: true,
        });

        const raw = result?.result?.value;
        if (!raw || typeof raw !== "string") {
          continue;
        }

        let entries;
        try {
          entries = JSON.parse(raw);
        } catch {
          continue;
        }

        for (const entry of Array.isArray(entries) ? entries : []) {
          const key = String(entry?.key || "");
          const value = entry?.value;
          if (!key || typeof value !== "string") {
            continue;
          }

          const maybeSession = parsePersistedSession(value);
          if (!maybeSession) {
            continue;
          }

          if (isPersistedSessionKey(key) || isPersistedSessionShape(maybeSession)) {
            sessions[key] = maybeSession;
          }
        }
      }

      if (Object.keys(sessions).length > 0) {
        break;
      }

      await delay(800);
    }

    return sessions;
  } finally {
    await client.close();
  }
}

function parsePersistedSession(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isPersistedSessionKey(key) {
  return key.startsWith("ps-") || key.toLowerCase().includes("persist");
}

function isPersistedSessionShape(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  return typeof value.blob === "string" && value.blob.length > 0;
}

async function resolveSweetLinkProfilePath(profileDir) {
  const defaultProfile = path.join(profileDir, "Default");
  const defaultCookiesDb = path.join(defaultProfile, "Cookies");
  if (await fileExists(defaultCookiesDb)) {
    return defaultProfile;
  }
  return profileDir;
}

function runCommand(command, args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
    });
  });
}

async function openDevToolsTarget(devtoolsPort, urlToOpen) {
  const encoded = encodeURIComponent(urlToOpen);

  const created = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${encoded}`, {
    method: "PUT",
  }).catch(() => null);

  if (created?.ok) {
    const payload = await created.json().catch(() => null);
    if (payload?.webSocketDebuggerUrl) {
      return payload.webSocketDebuggerUrl;
    }
  }

  const listed = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).catch(() => null);
  if (!listed?.ok) {
    return null;
  }

  const tabs = await listed.json().catch(() => []);
  if (!Array.isArray(tabs)) {
    return null;
  }

  for (const tab of tabs) {
    if (tab?.webSocketDebuggerUrl) {
      return tab.webSocketDebuggerUrl;
    }
  }

  return null;
}

async function createCdpClient(websocketUrl) {
  const ws = new WebSocket(websocketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (event) => reject(event.error || new Error("WebSocket error")));
  });

  let requestId = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!payload?.id || !pending.has(payload.id)) {
      return;
    }

    const wait = pending.get(payload.id);
    pending.delete(payload.id);

    if (payload.error) {
      wait.reject(new Error(`CDP ${wait.method} failed: ${JSON.stringify(payload.error)}`));
      return;
    }
    wait.resolve(payload.result);
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        requestId += 1;
        pending.set(requestId, { resolve, reject, method });
        ws.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    close() {
      return new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
          resolve();
          return;
        }
        ws.addEventListener("close", () => resolve(), { once: true });
        ws.close();
      });
    },
  };
}

function normalizeDevToolsCookie(cookie) {
  if (!cookie || typeof cookie !== "object") {
    return null;
  }
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    return null;
  }

  const domain = String(cookie.domain || "").trim();
  if (!domain) {
    return null;
  }

  const sameSite =
    cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
      ? cookie.sameSite
      : undefined;

  const expires =
    typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0
      ? Math.floor(cookie.expires)
      : undefined;

  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite,
    expires,
  };
}

function normalizeSweetCookie(cookie) {
  if (!cookie || typeof cookie !== "object") {
    return null;
  }
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    return null;
  }

  const domain = String(cookie.domain || "").trim();
  if (!domain) {
    return null;
  }

  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite:
      cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
        ? cookie.sameSite
        : undefined,
    expires:
      typeof cookie.expires === "number" && Number.isFinite(cookie.expires) && cookie.expires > 0
        ? Math.floor(cookie.expires)
        : undefined,
  };
}

function cookieMatchesDomain(cookieDomain, requestedDomain) {
  const normalizedCookieDomain = String(cookieDomain || "").trim().replace(/^\./, "").toLowerCase();
  const normalizedRequested = String(requestedDomain || "").trim().replace(/^\./, "").toLowerCase();
  if (!normalizedCookieDomain || !normalizedRequested) {
    return false;
  }
  return (
    normalizedCookieDomain === normalizedRequested ||
    normalizedRequested.endsWith(`.${normalizedCookieDomain}`) ||
    normalizedCookieDomain.endsWith(`.${normalizedRequested}`)
  );
}

function extractUidCandidates(cookiesByDomain) {
  const uids = new Set();
  for (const cookies of Object.values(cookiesByDomain || {})) {
    if (!Array.isArray(cookies)) {
      continue;
    }
    for (const cookie of cookies) {
      if (typeof cookie?.name !== "string") {
        continue;
      }
      if (cookie.name.startsWith("AUTH-")) {
        uids.add(cookie.name.slice("AUTH-".length));
      }
      if (cookie.name.startsWith("REFRESH-")) {
        uids.add(cookie.name.slice("REFRESH-".length));
      }
    }
  }
  return [...uids];
}

async function verifyCalendarApiSession(cookiesByDomain, uidCandidates) {
  const hosts = ["https://calendar.proton.me", "https://account.proton.me"];

  for (const uid of uidCandidates) {
    for (const host of hosts) {
      const cookieHeader = buildProbeCookieHeader(cookiesByDomain, host, uid);
      if (!cookieHeader) {
        continue;
      }

      const url = `${host}/api/calendar/v1`;
      let response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "application/vnd.protonmail.v1+json",
            Cookie: cookieHeader,
            "x-pm-appversion": "web-calendar@5.0.101.3",
            "x-pm-locale": "en-US",
            "x-pm-uid": uid,
          },
          signal: AbortSignal.timeout(7000),
        });
      } catch {
        continue;
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        continue;
      }

      const calendars = Array.isArray(payload?.Calendars) ? payload.Calendars : [];
      if (response.ok && [1000, 1001].includes(payload?.Code) && calendars.length > 0) {
        return {
          uid,
          host,
          calendarCount: calendars.length,
        };
      }
    }
  }

  return null;
}

function buildProbeCookieHeader(cookiesByDomain, host, uid) {
  const hostname = new URL(host).hostname;
  const cookies = flattenCookies(cookiesByDomain);
  const map = new Map();

  for (const cookie of cookies) {
    const name = String(cookie?.name || "");
    const value = String(cookie?.value || "");
    const domain = String(cookie?.domain || "");
    if (!name || !value) {
      continue;
    }

    const isHostCookie = cookieMatchesDomain(domain, hostname);
    const isAuthCookie =
      name === `AUTH-${uid}` ||
      name === `REFRESH-${uid}` ||
      name === "Session-Id" ||
      name === "Tag" ||
      name === "Domain" ||
      name === "iaas";

    if (!isHostCookie && !isAuthCookie) {
      continue;
    }

    if (isHostCookie) {
      map.set(name, value);
      continue;
    }

    if (!map.has(name)) {
      map.set(name, value);
    }
  }

  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function readChromeSafeStoragePassword() {
  if (process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD) {
    return process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD;
  }

  if (process.platform !== "darwin") {
    return "";
  }

  try {
    const result = await runCommand(
      "security",
      ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
      process.env,
      { timeoutMs: 2000 }
    );
    const password = result.stdout.trim();
    if (!password) {
      return "";
    }
    process.env.SWEET_COOKIE_CHROME_SAFE_STORAGE_PASSWORD = password;
    return password;
  } catch {
    return "";
  }
}

async function shutdownChrome(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }

  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(1200);
  try {
    process.kill(child.pid, 0);
    process.kill(child.pid, "SIGKILL");
  } catch {
    // already stopped
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
