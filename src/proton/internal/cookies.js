export function getSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) {
      return values.filter((value) => typeof value === "string" && value.length > 0);
    }
  }

  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }
  return [combined];
}

export function flattenBundleCookies(bundle) {
  const rows = [];

  if (Array.isArray(bundle?.cookies)) {
    rows.push(...bundle.cookies);
  }

  if (bundle?.cookiesByDomain && typeof bundle.cookiesByDomain === "object") {
    for (const [domain, cookies] of Object.entries(bundle.cookiesByDomain)) {
      if (!Array.isArray(cookies)) {
        continue;
      }
      rows.push(...cookies.map((cookie) => ({ domain, ...cookie })));
    }
  }

  return rows.filter((cookie) => cookie && typeof cookie === "object");
}

export function parseCookieHeaderToMap(cookieHeader) {
  const map = new Map();
  if (!cookieHeader) {
    return map;
  }

  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (!name) {
      continue;
    }

    map.set(name, value);
  }

  return map;
}

export function mapToCookieHeader(map) {
  const pairs = [];
  for (const [name, value] of map.entries()) {
    if (!name) {
      continue;
    }
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

export function describeCookieChanges(changes) {
  return changes.map((change) => ({
    action: change.action,
    name: change.name,
    domain: change.domain,
    path: change.path,
    previousExpiresAt: formatExpiry(change.previousExpiresAt),
    nextExpiresAt: formatExpiry(change.nextExpiresAt),
  }));
}

function formatExpiry(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}
