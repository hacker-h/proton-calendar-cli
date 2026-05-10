import test from "node:test";
import assert from "node:assert/strict";
import * as openpgp from "openpgp";
import { DEFAULT_PROTON_APP_VERSION } from "../src/constants.js";
import { ApiError, toErrorPayload } from "../src/errors.js";
import {
  buildCreateSyncRequestBody,
  buildSharedParts,
  buildUpdateSyncRequestBody,
  decryptPersistedSessionKeyPassword,
  ProtonCalendarClient,
  resolveUpdateRecurrence,
} from "../src/proton/proton-client.js";

test("authStatus uses UID candidate, cookies, and Proton headers", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return jsonResponse(200, {
      Code: 1000,
      User: {
        Name: "assistant",
        ID: "user-1",
      },
    });
  };

  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return "pm-session=valid; pm-auth=valid";
      },
      async getPersistedSessions() {
        return {};
      },
    },
    fetchImpl,
    maxRetries: 0,
  });

  const status = await client.authStatus();
  assert.equal(status.uid, "uid-123");
  assert.equal(status.username, "assistant");
  assert.equal(status.userId, "user-1");

  assert.equal(requests.length, 2);
  const headers = requests[0].init.headers;
  assert.match(DEFAULT_PROTON_APP_VERSION, /^web-calendar@\d+\.\d+\.\d+\.\d+$/);
  assert.equal(headers["x-pm-uid"], "uid-123");
  assert.equal(headers["x-pm-appversion"], DEFAULT_PROTON_APP_VERSION);
  assert.equal(headers.Cookie, "pm-session=valid; pm-auth=valid");
});

test("authStatus returns AUTH_EXPIRED when upstream is unauthorized", async () => {
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return "pm-session=expired";
      },
      async getPersistedSessions() {
        return {};
      },
    },
    fetchImpl: async () => jsonResponse(401, { Code: 2001, Error: "Unauthorized" }),
    maxRetries: 0,
  });

  await assert.rejects(
    () => client.authStatus(),
    (error) => error?.code === "AUTH_EXPIRED" && error?.status === 401
  );
});

test("rate limited Proton requests respect Retry-After before retrying", async () => {
  const delays = [];
  let calendarAttempts = 0;
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: testSessionStore(),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      calendarAttempts += 1;
      if (calendarAttempts === 1) {
        return jsonResponse(429, { Code: 12087 }, [["Retry-After", "2"]]);
      }
      return jsonResponse(200, { Code: 1000, Calendars: [{ ID: "cal-1" }] });
    },
    maxRetries: 1,
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  const calendars = await client.listCalendars();
  assert.equal(calendarAttempts, 2);
  assert.deepEqual(delays, [2000]);
  assert.deepEqual(calendars.map((calendar) => calendar.id), ["cal-1"]);
});

test("final rate limited Proton response has stable retry details", async () => {
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: testSessionStore(),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(429, { Code: 12087, Error: "rate limited" }, [["Retry-After", "120"]]);
    },
    maxRetries: 0,
  });

  await assert.rejects(
    () => client.listCalendars(),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.deepEqual(error.details, {
        status: 429,
        retryable: true,
        retryAfterMs: 120000,
        retryAfterSeconds: 120,
      });
      return true;
    }
  );
});

test("final upstream 503 response remains retryable with Retry-After details", async () => {
  const delays = [];
  let attempts = 0;
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: testSessionStore(),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      attempts += 1;
      return jsonResponse(503, { Code: 503 }, [["Retry-After", "120"]]);
    },
    maxRetries: 1,
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  await assert.rejects(
    () => client.listCalendars(),
    (error) => {
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.status, 503);
      assert.deepEqual(error.details, {
        status: 503,
        retryable: true,
        retryAfterMs: 120000,
        retryAfterSeconds: 120,
        code: 503,
      });
      return true;
    }
  );
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [120000]);
});

test("upstream 503 retries with fallback backoff when Retry-After is absent", async () => {
  const delays = [];
  let attempts = 0;
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: testSessionStore(),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse(503, { Code: 503 });
      }
      return jsonResponse(200, { Code: 1000, Calendars: [{ ID: "cal-1" }] });
    },
    maxRetries: 1,
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  const calendars = await client.listCalendars();
  assert.deepEqual(calendars.map((calendar) => calendar.id), ["cal-1"]);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [240]);
});

test("interactive auth challenges do not trigger relogin", async () => {
  let reloginAttempts = 0;
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: testSessionStore(),
    authManager: {
      async recover() {
        reloginAttempts += 1;
        return true;
      },
    },
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(403, { Code: 9002, Error: "Human verification required" });
    },
    maxRetries: 0,
  });

  await assert.rejects(
    () => client.listCalendars(),
    (error) => {
      assert.equal(error.code, "AUTH_CHALLENGE_REQUIRED");
      assert.equal(error.status, 403);
      assert.deepEqual(error.details, {
        status: 403,
        retryable: false,
        authState: "captcha",
      });
      return true;
    }
  );
  assert.equal(reloginAttempts, 0);
});

test("invalid refresh and permission auth states are stable and non-retryable", async () => {
  const cases = [
    {
      payload: { Code: 2001, Error: "invalid refresh token" },
      code: "AUTH_EXPIRED",
      message: "Proton session cannot be refreshed",
      authState: "invalid_refresh",
    },
    {
      payload: { Code: 403, Error: "paid plan required" },
      code: "PROTON_PLAN_REQUIRED",
      message: "Proton account plan does not allow this operation",
      authState: "plan_required",
    },
    {
      payload: { Code: 403, Error: "permission denied" },
      code: "PROTON_PERMISSION_DENIED",
      message: "Proton denied access to this operation",
      authState: "permission_denied",
    },
  ];

  for (const current of cases) {
    let reloginAttempts = 0;
    const client = new ProtonCalendarClient({
      baseUrl: "https://calendar.proton.me",
      sessionStore: testSessionStore(),
      authManager: {
        async recover() {
          reloginAttempts += 1;
          return true;
        },
      },
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/core/v4/users") {
          return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
        }
        return jsonResponse(403, current.payload);
      },
      maxRetries: 0,
    });

    await assert.rejects(
      () => client.listCalendars(),
      (error) => {
        assert.equal(error.code, current.code);
        assert.equal(error.message, current.message);
        assert.deepEqual(error.details, {
          status: 403,
          retryable: false,
          authState: current.authState,
        });
        return true;
      }
    );
    assert.equal(reloginAttempts, 0);
  }
});

test("upstream Proton error details exclude raw payload secrets", async () => {
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return "pm-session=valid; pm-auth=valid";
      },
      async getPersistedSessions() {
        return {};
      },
    },
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(200, {
        Code: 9001,
        Error: "REFRESH-secret leaked upstream message",
        Details: {
          AccessToken: "access-secret",
          Cookie: "AUTH-uid-123=auth-secret",
        },
      });
    },
    maxRetries: 0,
  });

  await assert.rejects(
    () => client.listCalendars(),
    (error) => {
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "Unexpected upstream response");
      assert.deepEqual(error.details, { code: 9001 });
      assert.equal(serialized.includes("REFRESH-secret"), false);
      assert.equal(serialized.includes("access-secret"), false);
      assert.equal(serialized.includes("auth-secret"), false);
      return true;
    }
  );
});

test("API error envelopes sanitize raw upstream payload details", () => {
  const envelope = toErrorPayload(
    new ApiError(502, "UPSTREAM_ERROR", "Upstream request failed", {
      status: 502,
      payload: {
        Code: 9001,
        Error: "REFRESH-secret leaked upstream message",
        Details: {
          Cookie: "AUTH-uid-123=auth-secret",
        },
      },
    })
  );

  const serialized = JSON.stringify(envelope);
  assert.deepEqual(envelope.error.details, { status: 502, code: 9001 });
  assert.equal(serialized.includes("REFRESH-secret"), false);
  assert.equal(serialized.includes("auth-secret"), false);
  assert.equal(serialized.includes("payload"), false);
});

test("persisted session blobs use Proton legacy 16-byte AES-GCM IV", async () => {
  const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const iv = Uint8Array.from({ length: 16 }, (_, index) => index + 101);
  const plaintext = new TextEncoder().encode(JSON.stringify({ keyPassword: "calendar-key-password" }));
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext));
  const persistedBlob = concatBytes(iv, ciphertext);

  assert.equal(
    await decryptPersistedSessionKeyPassword({
      clientKeyBase64: toBase64(keyBytes),
      persistedBlobBase64: toBase64(persistedBlob),
    }),
    "calendar-key-password"
  );
  await assert.rejects(
    () => decryptSessionBlobWithIvBytes(keyBytes, persistedBlob, 12),
    (error) => error instanceof DOMException || error instanceof Error
  );
});

test("listCalendars normalizes Proton calendar payload", async () => {
  const requests = [];
  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return "pm-session=valid; pm-auth=valid";
      },
      async getPersistedSessions() {
        return {};
      },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(200, {
        Code: 1000,
        Calendars: [
          { ID: "cal-1", Name: "Work", Color: "#3366ff", Permissions: 127 },
          { ID: "cal-2", DisplayName: "Personal" },
        ],
      });
    },
    maxRetries: 0,
  });

  const calendars = await client.listCalendars();
  assert.deepEqual(calendars, [
    { id: "cal-1", name: "Work", color: "#3366ff", permissions: 127 },
    { id: "cal-2", name: "Personal", color: null, permissions: null },
  ]);
  assert.equal(new URL(requests.at(-1).url).pathname, "/api/calendar/v1");
});

test("authStatus refreshes auth cookies and retries request", async () => {
  const calls = [];
  let usersRequestCount = 0;
  const setCookieChanges = [];
  let refreshedCookies = false;

  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);

    if (parsed.pathname === "/api/core/v4/users") {
      usersRequestCount += 1;
      if (usersRequestCount === 1) {
        return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
      }
      return jsonResponse(200, {
        Code: 1000,
        User: {
          Name: "assistant",
          ID: "user-1",
        },
      });
    }

    if (parsed.pathname === "/api/auth/refresh") {
      return jsonResponse(
        200,
        { Code: 1000 },
        [
          [
            "set-cookie",
            "AUTH-uid-123=new-auth; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly; SameSite=None",
          ],
          [
            "set-cookie",
            "REFRESH-uid-123=%7B%22RefreshToken%22%3A%22fresh%22%2C%22UID%22%3A%22uid-123%22%7D; Path=/api/auth/refresh; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly; SameSite=None",
          ],
        ]
      );
    }

    throw new Error(`Unexpected URL: ${parsed.pathname}`);
  };

  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        if (refreshedCookies) {
          return "AUTH-uid-123=new-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22fresh%22%2C%22UID%22%3A%22uid-123%22%7D";
        }
        return "AUTH-uid-123=old-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D";
      },
      async getPersistedSessions() {
        return {};
      },
      async getBundle() {
        return {
          cookies: [
            {
              name: "REFRESH-uid-123",
              value: "%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D",
              domain: "calendar.proton.me",
              path: "/api/auth/refresh",
            },
          ],
        };
      },
      async applySetCookieHeaders(url, headers) {
        setCookieChanges.push({ url, headers });
        refreshedCookies = true;
        return [
          {
            action: "updated",
            name: "AUTH-uid-123",
            domain: "calendar.proton.me",
            path: "/api/",
            previousExpiresAt: Date.parse("2026-01-01T00:00:00.000Z"),
            nextExpiresAt: Date.parse("2099-12-30T00:00:00.000Z"),
          },
        ];
      },
    },
    fetchImpl,
    maxRetries: 0,
  });

  const status = await client.authStatus();
  assert.equal(status.uid, "uid-123");
  assert.equal(status.username, "assistant");
  assert.equal(calls.includes("/api/auth/refresh"), true);
  assert.equal(setCookieChanges.length >= 1, true);
});

test("authStatus falls back to relogin when refresh cannot recover session", async () => {
  const calls = [];
  let usersRequestCount = 0;
  let reloginCount = 0;
  let refreshedCookies = false;
  let invalidated = 0;

  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);

    if (parsed.pathname === "/api/core/v4/users") {
      usersRequestCount += 1;
      if (usersRequestCount === 1) {
        return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
      }
      return jsonResponse(200, {
        Code: 1000,
        User: {
          Name: "assistant",
          ID: "user-1",
        },
      });
    }

    if (parsed.pathname === "/api/auth/refresh" || parsed.pathname === "/api/auth/v4/refresh") {
      return jsonResponse(400, { Code: 10013, Error: "Refresh token invalid" });
    }

    throw new Error(`Unexpected URL: ${parsed.pathname}`);
  };

  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return refreshedCookies
          ? "AUTH-uid-123=relogin-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22fresh%22%2C%22UID%22%3A%22uid-123%22%7D"
          : "AUTH-uid-123=old-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D";
      },
      async getPersistedSessions() {
        return {};
      },
      async getBundle() {
        return {
          cookies: [
            {
              name: "REFRESH-uid-123",
              value: "%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D",
              domain: "calendar.proton.me",
              path: "/api/auth/refresh",
            },
          ],
        };
      },
      async applySetCookieHeaders() {
        return [];
      },
      async invalidate() {
        invalidated += 1;
      },
    },
    authManager: {
      async recover() {
        reloginCount += 1;
        refreshedCookies = true;
        return true;
      },
    },
    maxRetries: 0,
    fetchImpl,
  });

  const status = await client.authStatus();
  assert.equal(status.uid, "uid-123");
  assert.equal(status.username, "assistant");
  assert.equal(reloginCount, 1);
  assert.equal(invalidated >= 1, true);
  assert.equal(calls.includes("/api/auth/refresh") || calls.includes("/api/auth/v4/refresh"), true);
});

test("concurrent auth failures share a single relogin attempt", async () => {
  let reloginCount = 0;
  let refreshedCookies = false;

  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/core/v4/users") {
      if (!refreshedCookies) {
        return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
      }
      return jsonResponse(200, {
        Code: 1000,
        User: {
          Name: "assistant",
          ID: "user-1",
        },
      });
    }

    if (parsed.pathname === "/api/auth/refresh" || parsed.pathname === "/api/auth/v4/refresh") {
      return jsonResponse(400, { Code: 10013, Error: "Refresh token invalid" });
    }

    throw new Error(`Unexpected URL: ${parsed.pathname}`);
  };

  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getUIDCandidates() {
        return ["uid-123"];
      },
      async getCookieHeader() {
        return refreshedCookies
          ? "AUTH-uid-123=relogin-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22fresh%22%2C%22UID%22%3A%22uid-123%22%7D"
          : "AUTH-uid-123=old-auth; REFRESH-uid-123=%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D";
      },
      async getPersistedSessions() {
        return {};
      },
      async getBundle() {
        return {
          cookies: [
            {
              name: "REFRESH-uid-123",
              value: "%7B%22RefreshToken%22%3A%22old%22%2C%22UID%22%3A%22uid-123%22%7D",
              domain: "calendar.proton.me",
              path: "/api/auth/refresh",
            },
          ],
        };
      },
      async applySetCookieHeaders() {
        return [];
      },
      async invalidate() {},
    },
    authManager: {
      inFlightRecovery: null,
      async recover() {
        if (this.inFlightRecovery) {
          return this.inFlightRecovery;
        }
        this.inFlightRecovery = (async () => {
          reloginCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          refreshedCookies = true;
          this.inFlightRecovery = null;
          return true;
        })();
        return this.inFlightRecovery;
      },
    },
    maxRetries: 0,
    fetchImpl,
  });

  const [first, second] = await Promise.all([client.authStatus(), client.authStatus()]);
  assert.equal(first.uid, "uid-123");
  assert.equal(second.uid, "uid-123");
  assert.equal(reloginCount, 1);
});

test("event mutations send idempotency keys to Proton sync requests", async () => {
  const { client, requests } = await createMutationClientFixture();

  await client.createEvent({
    calendarId: "cal-1",
    event: {
      title: "Create with key",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
    },
    idempotencyKey: "create-key",
  });

  await client.updateEvent({
    calendarId: "cal-1",
    eventId: "evt-1",
    patch: { title: "Update with key" },
    idempotencyKey: "update-key",
  });

  await client.deleteEvent({
    calendarId: "cal-1",
    eventId: "evt-1",
    idempotencyKey: "delete-key",
  });

  await client.deleteEvent({
    calendarId: "cal-1",
    eventId: "evt-1",
  });

  assert.deepEqual(
    requests
      .filter((request) => request.pathname === "/api/calendar/v1/cal-1/events/sync")
      .map((request) => request.headers["X-Idempotency-Key"]),
    ["create-key", "update-key", "delete-key", undefined]
  );
});

test("buildSharedParts keeps UTC timestamps for UTC events", () => {
  const parts = buildSharedParts({
    uid: "event-1",
    sequence: 0,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-03-21T10:00:00.000Z"),
    endDate: new Date("2026-03-21T10:30:00.000Z"),
    title: "UTC event",
    description: "",
    location: "",
    recurrence: null,
    createdDate: new Date("2026-03-20T09:00:00.000Z"),
    timezone: "UTC",
  });

  assert.match(parts.signedPart, /DTSTART:20260321T100000Z/);
  assert.match(parts.signedPart, /DTEND:20260321T103000Z/);
  assert.doesNotMatch(parts.signedPart, /TZID=/);
  assert.doesNotMatch(parts.signedPart, /ORGANIZER/);
  assert.doesNotMatch(parts.encryptedPart, /ORGANIZER/);
});

test("buildSharedParts emits TZID timestamps for non-UTC events", () => {
  const parts = buildSharedParts({
    uid: "event-2",
    sequence: 2,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-03-21T10:00:00.000Z"),
    endDate: new Date("2026-03-21T11:30:00.000Z"),
    title: "Berlin event",
    description: "",
    location: "",
    recurrence: null,
    createdDate: new Date("2026-03-20T09:00:00.000Z"),
    timezone: "Europe/Berlin",
  });

  assert.match(parts.signedPart, /DTSTART;TZID=Europe\/Berlin:20260321T110000/);
  assert.match(parts.signedPart, /DTEND;TZID=Europe\/Berlin:20260321T123000/);
  assert.doesNotMatch(parts.signedPart, /ORGANIZER/);
  assert.doesNotMatch(parts.encryptedPart, /ORGANIZER/);
});

test("buildSharedParts emits VALUE=DATE for all-day events", () => {
  const parts = buildSharedParts({
    uid: "event-3",
    sequence: 1,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-04-08T22:00:00.000Z"),
    endDate: new Date("2026-04-09T22:00:00.000Z"),
    allDay: true,
    title: "All-day event",
    description: "",
    location: "",
    recurrence: null,
    createdDate: new Date("2026-04-08T21:00:00.000Z"),
    timezone: "Europe/Berlin",
  });

  assert.match(parts.signedPart, /DTSTART;VALUE=DATE:20260409/);
  assert.match(parts.signedPart, /DTEND;VALUE=DATE:20260410/);
  assert.doesNotMatch(parts.signedPart, /TZID=/);
  assert.doesNotMatch(parts.signedPart, /ORGANIZER/);
  assert.doesNotMatch(parts.encryptedPart, /ORGANIZER/);
});

test("buildSharedParts folds long ASCII VEVENT lines", () => {
  const title = "A".repeat(100);
  const description = "B".repeat(100);
  const location = "C".repeat(100);
  const parts = buildSharedParts({
    uid: "event-4",
    sequence: 0,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-03-21T10:00:00.000Z"),
    endDate: new Date("2026-03-21T10:30:00.000Z"),
    title,
    description,
    location,
    recurrence: null,
    createdDate: new Date("2026-03-20T09:00:00.000Z"),
    timezone: "UTC",
  });

  assertPhysicalLinesAtMost75Octets(parts.encryptedPart);
  assert.match(parts.encryptedPart, /SUMMARY:[^\r]+\r\n /);
  const properties = readUnfoldedProperties(parts.encryptedPart);
  assert.equal(properties.SUMMARY, title);
  assert.equal(properties.DESCRIPTION, description);
  assert.equal(properties.LOCATION, location);
});

test("buildSharedParts folds multibyte VEVENT lines without splitting characters", () => {
  const title = "Résumé ".repeat(14);
  const description = "説明".repeat(30);
  const parts = buildSharedParts({
    uid: "event-5",
    sequence: 0,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-03-21T10:00:00.000Z"),
    endDate: new Date("2026-03-21T10:30:00.000Z"),
    title,
    description,
    location: "会議室".repeat(12),
    recurrence: null,
    createdDate: new Date("2026-03-20T09:00:00.000Z"),
    timezone: "UTC",
  });

  assertPhysicalLinesAtMost75Octets(parts.encryptedPart);
  const properties = readUnfoldedProperties(parts.encryptedPart);
  assert.equal(properties.SUMMARY, title);
  assert.equal(properties.DESCRIPTION, description);
  assert.doesNotMatch(parts.encryptedPart, /�/);
});

test("buildSharedParts leaves exact-boundary VEVENT lines unfolded", () => {
  const title = "A".repeat(67);
  const parts = buildSharedParts({
    uid: "event-6",
    sequence: 0,
    organizerEmail: "bot@example.com",
    startDate: new Date("2026-03-21T10:00:00.000Z"),
    endDate: new Date("2026-03-21T10:30:00.000Z"),
    title,
    description: "",
    location: "",
    recurrence: null,
    createdDate: new Date("2026-03-20T09:00:00.000Z"),
    timezone: "UTC",
  });

  assertPhysicalLinesAtMost75Octets(parts.encryptedPart);
  const summaryLine = parts.encryptedPart.split("\r\n").find((line) => line.startsWith("SUMMARY:"));
  assert.equal(Buffer.byteLength(summaryLine, "utf8"), 75);
  assert.equal(parts.encryptedPart.includes(`${summaryLine}\r\n `), false);
});

test("buildCreateSyncRequestBody defaults to organizer permissions", () => {
  const body = buildCreateSyncRequestBody({
    memberId: "member-1",
    sharedKeyPacket: "packet",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
  });

  assert.equal(body.MemberID, "member-1");
  assert.equal(body.Events.length, 1);
  assert.equal(body.Events[0].Overwrite, 0);
  assert.equal(body.Events[0].Event.Permissions, 3);
  assert.equal(body.Events[0].Event.IsOrganizer, 1);
  assert.equal(body.Events[0].Event.SharedKeyPacket, "packet");
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarEventContent"), false);
});

test("buildCreateSyncRequestBody grants organizer permissions when protected", () => {
  const body = buildCreateSyncRequestBody({
    memberId: "member-1",
    sharedKeyPacket: "packet",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
    protected: true,
  });

  assert.equal(body.Events[0].Event.Permissions, 3);
  assert.equal(body.Events[0].Event.IsOrganizer, 1);
  assert.equal(body.Events[0].Event.SharedKeyPacket, "packet");
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarEventContent"), false);
});

test("buildUpdateSyncRequestBody preserves scoped mutation flags and defaults to organizer ownership", () => {
  const seriesBody = buildUpdateSyncRequestBody({
    memberId: "member-1",
    eventId: "event-1",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
    notifications: null,
    color: null,
    scope: "series",
  });
  const followingBody = buildUpdateSyncRequestBody({
    memberId: "member-1",
    eventId: "event-1",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
    notifications: null,
    color: null,
    scope: "following",
    occurrenceStart: "2026-03-21T10:00:00.000Z",
  });
  const singleBody = buildUpdateSyncRequestBody({
    memberId: "member-1",
    eventId: "event-1",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
    notifications: null,
    color: null,
    scope: "single",
    occurrenceStart: "2026-03-21T10:00:00.000Z",
  });

  assert.equal(seriesBody.Events[0].Event.IsBreakingChange, 0);
  assert.equal(seriesBody.Events[0].Event.IsPersonalSingleEdit, false);
  assert.equal(Object.hasOwn(seriesBody.Events[0].Event, "SharedKeyPacket"), false);
  assert.equal(Object.hasOwn(seriesBody.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(seriesBody.Events[0].Event, "CalendarEventContent"), false);
  assert.equal(followingBody.Events[0].Event.Permissions, 3);
  assert.equal(followingBody.Events[0].Event.IsOrganizer, 1);
  assert.equal(followingBody.Events[0].Event.IsBreakingChange, 1);
  assert.equal(followingBody.Events[0].Event.IsPersonalSingleEdit, false);
  assert.equal(followingBody.Events[0].Event.RecurrenceID, 1774087200);
  assert.equal(Object.hasOwn(followingBody.Events[0].Event, "SharedKeyPacket"), false);
  assert.equal(Object.hasOwn(followingBody.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(followingBody.Events[0].Event, "CalendarEventContent"), false);
  assert.equal(singleBody.Events[0].Event.IsBreakingChange, 0);
  assert.equal(singleBody.Events[0].Event.IsPersonalSingleEdit, true);
  assert.equal(singleBody.Events[0].Event.RecurrenceID, 1774087200);
  assert.equal(Object.hasOwn(singleBody.Events[0].Event, "SharedKeyPacket"), false);
  assert.equal(Object.hasOwn(singleBody.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(singleBody.Events[0].Event, "CalendarEventContent"), false);
});

test("resolveUpdateRecurrence drops series rule for single edits", () => {
  const existingRecurrence = { freq: "DAILY", count: 4 };
  const patchRecurrence = { freq: "WEEKLY", count: 2 };

  assert.equal(resolveUpdateRecurrence({ scope: "single", existingRecurrence, patchRecurrence }), null);
  assert.deepEqual(
    resolveUpdateRecurrence({ scope: "series", existingRecurrence, patchRecurrence: undefined }),
    existingRecurrence
  );
  assert.deepEqual(
    resolveUpdateRecurrence({ scope: "following", existingRecurrence, patchRecurrence }),
    patchRecurrence
  );
});

test("buildUpdateSyncRequestBody grants organizer permissions when protected", () => {
  const body = buildUpdateSyncRequestBody({
    memberId: "member-1",
    eventId: "event-1",
    sharedEventContent: [{ Type: 2, Data: "signed" }],
    notifications: null,
    color: null,
    scope: "series",
    protected: true,
  });

  assert.equal(body.Events[0].Event.Permissions, 3);
  assert.equal(body.Events[0].Event.IsOrganizer, 1);
  assert.equal(Object.hasOwn(body.Events[0].Event, "SharedKeyPacket"), false);
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarKeyPacket"), false);
  assert.equal(Object.hasOwn(body.Events[0].Event, "CalendarEventContent"), false);
});

function jsonResponse(status, payload, headers = []) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
  });
}

function testSessionStore() {
  return {
    async getUIDCandidates() {
      return ["uid-123"];
    },
    async getCookieHeader() {
      return "pm-session=valid; pm-auth=valid";
    },
    async getPersistedSessions() {
      return {};
    },
  };
}

async function decryptSessionBlobWithIvBytes(keyBytes, blobBytes, ivBytes) {
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  await crypto.subtle.decrypt({ name: "AES-GCM", iv: blobBytes.slice(0, ivBytes) }, cryptoKey, blobBytes.slice(ivBytes));
}

function concatBytes(...parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function toBase64(input) {
  return Buffer.from(input).toString("base64");
}

async function createMutationClientFixture() {
  const requests = [];
  const addressKey = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ email: "bot@example.com" }],
    format: "object",
  });
  const calendarKey = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ email: "calendar@example.com" }],
    format: "object",
  });

  let storedEvent = null;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    const request = {
      method: init.method,
      pathname: parsed.pathname,
      headers: { ...init.headers },
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);

    if (request.method === "GET" && parsed.pathname === "/api/calendar/v1/cal-1/events/evt-1") {
      return jsonResponse(200, { Code: 1000, Event: storedEvent });
    }

    if (request.method === "PUT" && parsed.pathname === "/api/calendar/v1/cal-1/events/sync") {
      const syncEvent = request.body.Events[0].Event || {};
      storedEvent = buildRawSyncEvent(syncEvent, storedEvent);
      return jsonResponse(200, {
        Code: 1001,
        Responses: [{ Response: { Code: 1000, Event: storedEvent } }],
      });
    }

    throw new Error(`Unexpected request: ${request.method} ${parsed.pathname}`);
  };

  const client = new ProtonCalendarClient({
    baseUrl: "https://calendar.proton.me",
    sessionStore: {
      async getCookieHeader() {
        return "pm-session=valid; pm-auth=valid";
      },
    },
    fetchImpl,
    maxRetries: 0,
  });
  client.cachedUID = "uid-123";
  client.cachedContext = {
    uid: "uid-123",
    calendarId: "cal-1",
    memberId: "member-1",
    addressEmail: "bot@example.com",
    addressPrivateKey: addressKey.privateKey,
    calendarPrivateKey: calendarKey.privateKey,
    calendarPublicKey: calendarKey.privateKey.toPublic(),
  };

  return { client, requests };
}

function buildRawSyncEvent(syncEvent, previousEvent) {
  const sharedEvents = syncEvent.SharedEventContent || previousEvent?.SharedEvents || [];
  return {
    ...previousEvent,
    ...syncEvent,
    ID: "evt-1",
    CalendarID: "cal-1",
    UID: "evt-1@example.com",
    StartTime: 1773136800,
    EndTime: 1773138600,
    StartTimezone: "UTC",
    EndTimezone: "UTC",
    CreateTime: 1773000000,
    ModifyTime: 1773000001,
    Notifications: null,
    Color: null,
    SharedKeyPacket: syncEvent.SharedKeyPacket || previousEvent?.SharedKeyPacket,
    SharedEvents: sharedEvents,
  };
}

function assertPhysicalLinesAtMost75Octets(ics) {
  for (const line of ics.split("\r\n")) {
    if (!line) {
      continue;
    }
    assert.equal(Buffer.byteLength(line, "utf8") <= 75, true, `${line} exceeds 75 octets`);
  }
}

function readUnfoldedProperties(ics) {
  const properties = {};
  let current = "";
  for (const line of ics.split("\r\n")) {
    if (!line) {
      continue;
    }
    if (line.startsWith(" ")) {
      current += line.slice(1);
      continue;
    }
    if (current) {
      addProperty(properties, current);
    }
    current = line;
  }
  if (current) {
    addProperty(properties, current);
  }
  return properties;
}

function addProperty(properties, line) {
  const separator = line.indexOf(":");
  if (separator <= 0) {
    return;
  }
  properties[line.slice(0, separator)] = line.slice(separator + 1);
}
