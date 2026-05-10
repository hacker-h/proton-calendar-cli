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
  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(raw) {
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

export function parseCookieHeader(header) {
  const map = new Map();
  if (!header) {
    return map;
  }

  for (const part of String(header).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1);
    if (!name) {
      continue;
    }
    map.set(name, value);
  }

  return map;
}
