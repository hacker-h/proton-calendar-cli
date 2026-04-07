import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateSyncRequestBody,
  buildSharedParts,
  buildUpdateSyncRequestBody,
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
  assert.equal(headers["x-pm-uid"], "uid-123");
  assert.equal(headers["x-pm-appversion"], "web-calendar@5.0.101.3");
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
