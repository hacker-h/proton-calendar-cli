import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.js";

export class CookieSessionStore {
  constructor(options) {
    this.cookieBundlePath = path.resolve(options.cookieBundlePath);
    this.now = options.now || (() => Date.now());
    this.cachedMtimeMs = -1;
    this.cookies = [];
    this.bundle = {};
    this.lastLoadedAt = null;
  }

  getBundlePath() {
    return this.cookieBundlePath;
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
      source: this.bundle?.source || null,
      uidCandidates: Array.isArray(this.bundle?.uidCandidates) ? this.bundle.uidCandidates.length : 0,
      lastLoadedAt: this.lastLoadedAt,
    };
  }

  async getBundle() {
    await this.#reloadIfNeeded();
    return this.bundle;
  }

  async getUIDCandidates() {
    await this.#reloadIfNeeded();
    if (!Array.isArray(this.bundle?.uidCandidates)) {
      return [];
    }
    return this.bundle.uidCandidates.filter((value) => typeof value === "string" && value.length > 0);
  }

  async getPersistedSessions() {
    await this.#reloadIfNeeded();
    const sessions = this.bundle?.persistedSessions;
    if (!sessions || typeof sessions !== "object") {
      return {};
    }
    return sessions;
  }

  async getAuthCookieDiagnostics() {
    await this.#reloadIfNeeded();
    const byKey = new Map();

    for (const cookie of this.cookies) {
      if (!isAuthCookieName(cookie.name)) {
        continue;
      }

      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      const existing = byKey.get(key);
      if (!existing || toComparableExpiry(cookie.expiresAt) >= toComparableExpiry(existing.expiresAt)) {
        byKey.set(key, {
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          expiresAt: cookie.expiresAt,
        });
      }
    }

    return [...byKey.values()].sort((a, b) => `${a.domain}|${a.path}|${a.name}`.localeCompare(`${b.domain}|${b.path}|${b.name}`));
  }

  async applySetCookieHeaders(urlString, setCookieHeaders) {
    await this.#reloadIfNeeded();
    const requestUrl = new URL(urlString);
    const parsedCookies = parseSetCookieHeaders(setCookieHeaders, requestUrl, this.now());
    if (parsedCookies.length === 0) {
      return [];
    }

    const nowMs = this.now();
    const map = new Map(this.cookies.map((cookie) => [cookieKey(cookie), cookie]));
    const changes = [];

    for (const incoming of parsedCookies) {
      const key = cookieKey(incoming);
      const previous = map.get(key);

      if ((incoming.expiresAt !== null && incoming.expiresAt <= nowMs) || incoming.value === "") {
        if (previous) {
          map.delete(key);
          changes.push({
            action: "removed",
            name: incoming.name,
            domain: incoming.domain,
            path: incoming.path,
            previousExpiresAt: previous.expiresAt,
            nextExpiresAt: null,
          });
        }
        continue;
      }

      map.set(key, incoming);
      const action = previous ? "updated" : "added";
      const expiresChanged = !previous || previous.expiresAt !== incoming.expiresAt || previous.value !== incoming.value;
      if (!expiresChanged && action === "updated") {
        continue;
      }

      changes.push({
        action,
        name: incoming.name,
        domain: incoming.domain,
        path: incoming.path,
        previousExpiresAt: previous ? previous.expiresAt : null,
        nextExpiresAt: incoming.expiresAt,
      });
    }

    if (changes.length === 0) {
      return [];
    }

    this.cookies = [...map.values()].sort((a, b) => cookieKey(a).localeCompare(cookieKey(b)));
    this.bundle = buildUpdatedBundle(this.bundle, this.cookies);
    await writeFile(this.cookieBundlePath, `${JSON.stringify(this.bundle, null, 2)}\n`, { mode: 0o600 });

    const fileStat = await stat(this.cookieBundlePath);
    this.cachedMtimeMs = fileStat.mtimeMs;
    this.lastLoadedAt = new Date().toISOString();

    return changes;
  }

  async invalidate() {
    this.cachedMtimeMs = -1;
    this.lastLoadedAt = null;
    await this.#reloadIfNeeded();
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
    this.bundle = parsed && typeof parsed === "object" ? parsed : {};
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
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: typeof cookie.sameSite === "string" ? cookie.sameSite : undefined,
    expiresAt,
  };
}

function parseSetCookieHeaders(input, requestUrl, nowMs) {
  const rows = toSetCookieArray(input);
  const parsed = [];

  for (const line of rows) {
    const cookie = parseSetCookieLine(line, requestUrl, nowMs);
    if (cookie) {
      parsed.push(cookie);
    }
  }

  return parsed;
}

function toSetCookieArray(input) {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.filter((value) => typeof value === "string" && value.length > 0);
  }
  if (typeof input === "string" && input.length > 0) {
    return splitSetCookieString(input);
  }
  return [];
}

function splitSetCookieString(raw) {
  const rows = [];
  let cursor = "";
  let inExpires = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];
    cursor += char;

    if (cursor.toLowerCase().endsWith("expires=")) {
      inExpires = true;
      continue;
    }

    if (inExpires && char === ";") {
      inExpires = false;
      continue;
    }

    if (!inExpires && char === "," && next === " ") {
      const nextFragment = raw.slice(i + 2);
      if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+=/.test(nextFragment)) {
        rows.push(cursor.slice(0, -1).trim());
        cursor = "";
        i += 1;
      }
    }
  }

  if (cursor.trim()) {
    rows.push(cursor.trim());
  }

  return rows;
}

function parseSetCookieLine(line, requestUrl, nowMs) {
  const segments = String(line || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const [namePart, ...attrs] = segments;
  const equals = namePart.indexOf("=");
  if (equals <= 0) {
    return null;
  }

  const name = namePart.slice(0, equals).trim();
  const value = namePart.slice(equals + 1);
  if (!name) {
    return null;
  }

  let domain = requestUrl.hostname;
  let cookiePath = defaultCookiePath(requestUrl.pathname);
  let secure = false;
  let httpOnly = false;
  let sameSite;
  let expiresAt = null;
  let maxAge = null;

  for (const attr of attrs) {
    const idx = attr.indexOf("=");
    const key = (idx === -1 ? attr : attr.slice(0, idx)).trim().toLowerCase();
    const rawValue = idx === -1 ? "" : attr.slice(idx + 1).trim();

    if (key === "domain" && rawValue) {
      domain = rawValue.startsWith(".") ? rawValue.slice(1) : rawValue;
      continue;
    }
    if (key === "path" && rawValue) {
      cookiePath = rawValue;
      continue;
    }
    if (key === "secure") {
      secure = true;
      continue;
    }
    if (key === "httponly") {
      httpOnly = true;
      continue;
    }
    if (key === "samesite" && rawValue) {
      sameSite = rawValue;
      continue;
    }
    if (key === "expires" && rawValue) {
      const parsed = Date.parse(rawValue);
      if (!Number.isNaN(parsed)) {
        expiresAt = parsed;
      }
      continue;
    }
    if (key === "max-age" && rawValue) {
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed)) {
        maxAge = parsed;
      }
    }
  }

  if (maxAge !== null) {
    expiresAt = nowMs + maxAge * 1000;
  }

  return normalizeCookie({
    name,
    value,
    domain,
    path: cookiePath,
    secure,
    httpOnly,
    sameSite,
    expiresAt,
  });
}

function defaultCookiePath(pathname) {
  const value = pathname || "/";
  if (!value.startsWith("/")) {
    return "/";
  }
  if (value === "/") {
    return "/";
  }
  const index = value.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return value.slice(0, index);
}

function buildUpdatedBundle(previousBundle, cookies) {
  const next =
    previousBundle && typeof previousBundle === "object" && !Array.isArray(previousBundle)
      ? { ...previousBundle }
      : {};

  next.exportedAt = new Date().toISOString();
  next.cookies = cookies.map((cookie) => {
    const payload = {
      domain: cookie.domain,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };

    if (cookie.sameSite) {
      payload.sameSite = cookie.sameSite;
    }
    if (cookie.expiresAt !== null) {
      payload.expires = Math.floor(cookie.expiresAt / 1000);
    }

    return payload;
  });

  const grouped = {};
  for (const cookie of cookies) {
    if (!grouped[cookie.domain]) {
      grouped[cookie.domain] = [];
    }

    const payload = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };

    if (cookie.sameSite) {
      payload.sameSite = cookie.sameSite;
    }
    if (cookie.expiresAt !== null) {
      payload.expires = Math.floor(cookie.expiresAt / 1000);
    }

    grouped[cookie.domain].push(payload);
  }

  next.cookiesByDomain = grouped;
  return next;
}

function cookieKey(cookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function isAuthCookieName(name) {
  return (
    typeof name === "string" &&
    (name.startsWith("AUTH-") || name.startsWith("REFRESH-") || name === "Session-Id")
  );
}

function toComparableExpiry(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return value;
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
