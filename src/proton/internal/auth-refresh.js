import { mapToCookieHeader, parseCookieHeaderToMap } from "./cookies.js";

export function buildRefreshUrls(baseUrl, paths) {
  const urls = [];
  for (const pathname of paths) {
    urls.push(new URL(pathname, baseUrl).toString());
    urls.push(new URL(pathname, "https://account.proton.me").toString());
  }
  return [...new Set(urls)];
}

export function buildRefreshCookieHeader({ scopedHeader, cookies, uid }) {
  const scopedMap = parseCookieHeaderToMap(scopedHeader);
  const fallbackMap = new Map();

  for (const cookie of cookies) {
    const name = String(cookie?.name || "");
    if (!name) {
      continue;
    }

    if (name === `AUTH-${uid}` || name === `REFRESH-${uid}` || name === "Session-Id" || name === "Tag" || name === "Domain") {
      fallbackMap.set(name, String(cookie?.value || ""));
    }
  }

  return mapToCookieHeader(new Map([...fallbackMap, ...scopedMap]));
}

export function extractRefreshPayloadFromCookies(cookies, uid) {
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
