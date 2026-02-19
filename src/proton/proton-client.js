import { setTimeout as delay } from "node:timers/promises";
import { ApiError } from "../errors.js";

export class ProtonCalendarClient {
  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.sessionStore = options.sessionStore;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  async authStatus() {
    return this.#request("GET", "/api/v1/auth/status");
  }

  async listEvents({ calendarId, start, end, limit, cursor }) {
    return this.#request("GET", `/api/v1/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        start,
        end,
        limit: String(limit),
        cursor,
      },
    });
  }

  async getEvent({ calendarId, eventId }) {
    return this.#request(
      "GET",
      `/api/v1/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }

  async createEvent({ calendarId, event, idempotencyKey }) {
    return this.#request("POST", `/api/v1/calendars/${encodeURIComponent(calendarId)}/events`, {
      body: event,
      idempotencyKey,
    });
  }

  async updateEvent({ calendarId, eventId, patch, idempotencyKey }) {
    return this.#request(
      "PATCH",
      `/api/v1/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        body: patch,
        idempotencyKey,
      }
    );
  }

  async deleteEvent({ calendarId, eventId, idempotencyKey }) {
    return this.#request(
      "DELETE",
      `/api/v1/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { idempotencyKey }
    );
  }

  async #request(method, pathname, options = {}) {
    const url = new URL(pathname, this.baseUrl);
    const query = options.query || {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, value);
    }

    const cookieHeader = await this.sessionStore.getCookieHeader(url.toString());
    if (!cookieHeader) {
      throw new ApiError(401, "AUTH_EXPIRED", "No valid session cookies available");
    }

    const headers = {
      Accept: "application/json",
      Cookie: cookieHeader,
    };

    if (options.idempotencyKey) {
      headers["X-Idempotency-Key"] = options.idempotencyKey;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      const isFinalAttempt = attempt === this.maxRetries;
      attempt += 1;

      try {
        const response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.status === 401 || response.status === 403) {
          throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized");
        }

        if (response.status === 404) {
          throw new ApiError(404, "NOT_FOUND", "Resource not found");
        }

        if ((response.status === 429 || response.status >= 500) && !isFinalAttempt) {
          await delay(backoffMs(attempt));
          continue;
        }

        const payload = await parseResponsePayload(response);
        if (!response.ok) {
          throw new ApiError(response.status, "UPSTREAM_ERROR", "Upstream request failed", {
            status: response.status,
            payload,
          });
        }

        if (payload && typeof payload === "object" && "data" in payload) {
          return payload.data;
        }

        return payload;
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }

        if (isFinalAttempt) {
          throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend", {
            message: error?.message,
          });
        }

        await delay(backoffMs(attempt));
      }
    }

    throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend");
  }
}

function backoffMs(attempt) {
  return Math.min(1000, 100 * 2 ** attempt);
}

async function parseResponsePayload(response) {
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
