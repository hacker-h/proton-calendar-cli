import test from "node:test";
import assert from "node:assert/strict";
import { ProtonCalendarClient } from "../src/proton/proton-client.js";

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

function jsonResponse(status, payload, headers = []) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
  });
}
