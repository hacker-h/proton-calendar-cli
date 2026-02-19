import { access } from "node:fs/promises";
import net from "node:net";

const AUTH_COOKIE_PATTERN = /auth|session|token|refresh|uid|pm-/i;

export const DEFAULT_PROTON_DOMAINS = ["calendar.proton.me", "account.proton.me", "proton.me"];

export function flattenCookies(cookiesByDomain) {
  const rows = [];
  for (const [domain, cookies] of Object.entries(cookiesByDomain || {})) {
    if (!Array.isArray(cookies)) {
      continue;
    }
    for (const cookie of cookies) {
      rows.push({ domain, ...cookie });
    }
  }
  return rows;
}

export function countAuthCookies(cookiesByDomain) {
  return flattenCookies(cookiesByDomain).filter((cookie) => {
    if (typeof cookie?.name !== "string" || typeof cookie?.value !== "string") {
      return false;
    }
    return AUTH_COOKIE_PATTERN.test(cookie.name) && cookie.value.length > 0;
  }).length;
}

export function hasCalendarAppTarget(devtoolsTargets) {
  if (!Array.isArray(devtoolsTargets)) {
    return false;
  }

  return devtoolsTargets.some((target) => {
    try {
      const url = new URL(target.url);
      if (!url.hostname.endsWith("calendar.proton.me")) {
        return false;
      }
      return !url.pathname.includes("login");
    } catch {
      return false;
    }
  });
}

export function looksAuthenticated(cookiesByDomain, devtoolsTargets) {
  return countAuthCookies(cookiesByDomain) >= 2 && hasCalendarAppTarget(devtoolsTargets);
}

export async function fetchDevtoolsTargets(devtoolsPort) {
  const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`);
  if (!response.ok) {
    return [];
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

export async function findAvailablePort(start = 9222, end = 9322) {
  for (let port = start; port <= end; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error("No free port found between 9222 and 9322");
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function fileExists(pathname) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}
