export function sanitizeUpstreamPayload(payload) {
  const details = {};
  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    details.code = payload.Code;
  }
  const upstreamError = readSafeUpstreamText(payload?.Error || payload?.error);
  if (upstreamError) {
    details.upstreamError = upstreamError;
  }
  const upstreamMessage = readSafeUpstreamText(payload?.Message || payload?.message);
  if (upstreamMessage) {
    details.upstreamMessage = upstreamMessage;
  }
  return details;
}

function readSafeUpstreamText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || /AUTH-[A-Za-z0-9_-]+|REFRESH-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|cookie|token|password/i.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 200);
}

export function backoffMs(attempt) {
  return Math.min(1500, 120 * 2 ** attempt);
}

export function readRetryAfterDetails(response, retryAfterMaxMs) {
  const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
  if (!Number.isFinite(retryAfterMs)) {
    return {};
  }

  const maxMs = Number(retryAfterMaxMs);
  const cappedMs = Number.isFinite(maxMs) && maxMs >= 0 ? Math.min(retryAfterMs, maxMs) : retryAfterMs;
  return {
    retryAfterMs: cappedMs,
    retryAfterSeconds: Math.ceil(cappedMs / 1000),
  };
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) {
    return Number.NaN;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) {
    return Number.NaN;
  }

  return Math.max(0, dateMs - nowMs);
}

export function classifyAuthState(status, payload) {
  if (![401, 403].includes(status)) {
    return null;
  }

  const text = JSON.stringify(payload || {}).toLowerCase();
  if (/captcha|human.?verification|verify you are human/.test(text)) {
    return authState("AUTH_CHALLENGE_REQUIRED", "Proton requires interactive verification", "captcha");
  }
  if (/two.?factor|2fa|mfa|one.?time code|security code/.test(text)) {
    return authState("AUTH_CHALLENGE_REQUIRED", "Proton requires interactive verification", "mfa");
  }
  if (/email code|mail code/.test(text)) {
    return authState("AUTH_CHALLENGE_REQUIRED", "Proton requires interactive verification", "email_code");
  }
  if (/locked|disabled/.test(text)) {
    return authState("AUTH_CHALLENGE_REQUIRED", "Proton requires interactive verification", "account_locked");
  }
  if (/invalid.?refresh|refresh.?token|invalid.?grant|session revoked|deauth/.test(text)) {
    return authState("AUTH_EXPIRED", "Proton session cannot be refreshed", "invalid_refresh");
  }
  if (/paid|plan|subscription/.test(text)) {
    return authState("PROTON_PLAN_REQUIRED", "Proton account plan does not allow this operation", "plan_required");
  }
  if (/permission|not allowed|forbidden|access denied/.test(text)) {
    return authState("PROTON_PERMISSION_DENIED", "Proton denied access to this operation", "permission_denied");
  }
  return null;
}

function authState(code, message, authStateValue) {
  return {
    code,
    message,
    authState: authStateValue,
  };
}

export async function parseResponsePayload(response) {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
