import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";

export class CookieSessionStore {
  constructor(options) {
    this.cookieBundlePath = path.resolve(options.cookieBundlePath);
    this.now = options.now || (() => Date.now());
    this.cachedMtimeMs = -1;
    this.cookies = [];
    this.lastLoadedAt = null;
  }

  async getCookieHeader(urlString) {
    await this.#reloadIfNeeded();
    const url = new URL(urlString);
    const matched = this.cookies.filter((cookie) => matchesCookie(cookie, url, this.now()));
    if (matched.length === 0) {
      return "";
    }
    return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  async getSummary() {
    await this.#reloadIfNeeded();
    const domains = new Set(this.cookies.map((cookie) => cookie.domain).filter(Boolean));
    return {
      cookieBundlePath: this.cookieBundlePath,
      cookieCount: this.cookies.length,
      domains: [...domains].sort(),
      lastLoadedAt: this.lastLoadedAt,
    };
  }

  async #reloadIfNeeded() {
    let fileStat;
    try {
      fileStat = await stat(this.cookieBundlePath);
    } catch {
      throw new ApiError(
        401,
        "COOKIE_BUNDLE_MISSING",
        `Cookie bundle not found at ${this.cookieBundlePath}`
      );
    }

    if (fileStat.mtimeMs === this.cachedMtimeMs) {
      return;
    }

    let raw;
    try {
      raw = await readFile(this.cookieBundlePath, "utf8");
    } catch {
      throw new ApiError(401, "COOKIE_BUNDLE_UNREADABLE", "Unable to read cookie bundle");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError(401, "COOKIE_BUNDLE_INVALID", "Cookie bundle JSON is invalid");
    }

    const cookies = parseCookies(parsed);
    if (cookies.length === 0) {
      throw new ApiError(401, "COOKIE_BUNDLE_EMPTY", "Cookie bundle does not contain usable cookies");
    }

    this.cachedMtimeMs = fileStat.mtimeMs;
    this.cookies = cookies;
    this.lastLoadedAt = new Date().toISOString();
  }
}

function parseCookies(parsed) {
  const rows = [];

  if (Array.isArray(parsed?.cookies)) {
    rows.push(...parsed.cookies);
  }

  if (parsed?.cookiesByDomain && typeof parsed.cookiesByDomain === "object") {
    for (const [domain, cookies] of Object.entries(parsed.cookiesByDomain)) {
      if (!Array.isArray(cookies)) {
        continue;
      }
      rows.push(...cookies.map((cookie) => ({ domain, ...cookie })));
    }
  }

  return rows
    .map((cookie) => normalizeCookie(cookie))
    .filter((cookie) => cookie && cookie.name && cookie.value);
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== "object") {
    return null;
  }

  const domain = normalizeDomain(cookie.domain || cookie.host || "");
  const expiresAt = readExpiresAt(cookie);

  return {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain,
    path: typeof cookie.path === "string" && cookie.path.length > 0 ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    expiresAt,
  };
}

function normalizeDomain(domain) {
  const normalized = String(domain || "").trim().toLowerCase();
  if (normalized.startsWith(".")) {
    return normalized.slice(1);
  }
  return normalized;
}

function readExpiresAt(cookie) {
  const candidates = [cookie.expiresAt, cookie.expires, cookie.expirationDate, cookie.expiry];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value * 1000;
      return ms;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function matchesCookie(cookie, requestUrl, nowMs) {
  if (cookie.expiresAt !== null && cookie.expiresAt <= nowMs) {
    return false;
  }

  if (cookie.secure && requestUrl.protocol !== "https:") {
    return false;
  }

  if (!domainMatches(cookie.domain, requestUrl.hostname)) {
    return false;
  }

  return pathMatches(cookie.path, requestUrl.pathname);
}

function domainMatches(cookieDomain, hostname) {
  if (!cookieDomain) {
    return false;
  }
  const host = hostname.toLowerCase();
  const domain = cookieDomain.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(cookiePath, pathname) {
  const normalizedCookiePath = cookiePath || "/";
  const normalizedPathname = pathname || "/";
  if (normalizedCookiePath === "/") {
    return true;
  }
  return normalizedPathname.startsWith(normalizedCookiePath);
}
