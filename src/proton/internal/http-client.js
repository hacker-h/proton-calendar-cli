import { ApiError } from "../../errors.js";
import { backoffMs, classifyAuthState, parseResponsePayload, readRetryAfterDetails, sanitizeUpstreamPayload } from "./http.js";

export async function requestProtonJson({
  method,
  pathname,
  options = {},
  baseUrl,
  fetchImpl,
  sessionStore,
  appVersion,
  locale,
  timeoutMs,
  maxRetries,
  retryAfterMaxMs,
  delay,
  getUID,
  attemptAuthRefresh,
  attemptRelogin,
  persistResponseCookies,
}) {
  const uid = options.uid || (await getUID());
  const url = new URL(pathname, baseUrl);
  const origin = new URL(baseUrl).origin;

  const query = options.query || {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, value);
  }

  const baseHeaders = {
    Accept: "application/vnd.protonmail.v1+json",
    "x-pm-appversion": appVersion,
    "x-pm-locale": locale,
    "x-pm-uid": uid,
    ...(method === "GET" ? {} : { Origin: origin, Referer: `${origin}/` }),
    ...(options.extraHeaders || {}),
  };

  if (options.idempotencyKey) {
    baseHeaders["X-Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.body !== undefined) {
    baseHeaders["Content-Type"] = "application/json";
  }

  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  let attempt = 0;
  let authRefreshAttempted = false;

  while (attempt <= maxRetries) {
    const isFinalAttempt = attempt === maxRetries;
    attempt += 1;

    try {
      const cookieHeader = await sessionStore.getCookieHeader(url.toString());
      if (!cookieHeader) {
        throw new ApiError(401, "AUTH_EXPIRED", "No valid session cookies available");
      }

      const response = await fetchImpl(url, {
        method,
        headers: {
          ...baseHeaders,
          Cookie: cookieHeader,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      await persistResponseCookies(url, response, `${method}:${pathname}`);
      const payload = await parseResponsePayload(response);
      const retryDetails = readRetryAfterDetails(response, retryAfterMaxMs);
      const authState = classifyAuthState(response.status, payload);

      if (response.status === 429) {
        if (!isFinalAttempt) {
          await delay(retryDetails.retryAfterMs ?? backoffMs(attempt));
          continue;
        }
        throw new ApiError(429, "RATE_LIMITED", "Proton rate limit exceeded", {
          status: 429,
          retryable: true,
          ...retryDetails,
        });
      }

      if (authState) {
        throw new ApiError(response.status, authState.code, authState.message, {
          status: response.status,
          retryable: false,
          authState: authState.authState,
        });
      }

      if (response.status === 401 || response.status === 403) {
        if (options.allowAuthRefresh !== false && !authRefreshAttempted) {
          authRefreshAttempted = true;
          const refreshed = await attemptAuthRefresh(uid);
          if (refreshed) {
            attempt -= 1;
            continue;
          }
        }

        if (options.allowRelogin !== false) {
          const relogged = await attemptRelogin(uid, `${method}:${pathname}`);
          if (relogged) {
            attempt -= 1;
            continue;
          }
        }

        throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized", {
          status: response.status,
          ...sanitizeUpstreamPayload(payload),
        });
      }

      if (response.status === 404) {
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      }

      if (response.status >= 500 && !isFinalAttempt) {
        await delay(retryDetails.retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        throw new ApiError(response.status, "UPSTREAM_ERROR", "Upstream request failed", {
          status: response.status,
          retryable: response.status >= 500 ? true : undefined,
          ...retryDetails,
          ...sanitizeUpstreamPayload(payload),
        });
      }

      if (payload && typeof payload === "object" && typeof payload.Code === "number") {
        if (![1000, 1001].includes(payload.Code)) {
          throw new ApiError(502, "UPSTREAM_ERROR", "Unexpected upstream response", sanitizeUpstreamPayload(payload));
        }
      }

      return payload;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (isFinalAttempt) {
        throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend", {
          cause: "network",
        });
      }

      await delay(backoffMs(attempt));
    }
  }

  throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend");
}
