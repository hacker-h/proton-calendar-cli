import test from "node:test";
import assert from "node:assert/strict";
import { ProtonCalendarClient } from "../src/proton/proton-client.js";
import { startMockProtonServer } from "./helpers/mock-proton-server.js";

test("authStatus can authenticate through the mock Proton HTTP server", async () => {
  const proton = await startMockProtonServer({
    validSessionCookie: "valid-session",
    accountName: "assistant",
    userId: "user-1",
  });

  try {
    const client = new ProtonCalendarClient({
      baseUrl: proton.baseUrl,
      sessionStore: createSessionStore({ cookieHeader: "pm-session=valid-session" }),
      maxRetries: 0,
    });

    const status = await client.authStatus();

    assert.equal(status.uid, "uid-123");
    assert.equal(status.username, "assistant");
    assert.equal(status.userId, "user-1");

    const userRequests = proton.requests().filter((request) => request.pathname === "/api/core/v4/users");
    assert.equal(userRequests.length, 2);
    assert.equal(userRequests[0].headers["x-pm-uid"], "uid-123");
    assert.equal(userRequests[0].headers["x-pm-appversion"], "web-calendar@5.0.101.3");
    assert.equal(userRequests[0].headers.cookie, "pm-session=valid-session");
  } finally {
    await proton.close();
  }
});

test("authStatus maps mock Proton HTTP unauthorized responses to AUTH_EXPIRED", async () => {
  const proton = await startMockProtonServer({ validSessionCookie: "valid-session" });

  try {
    const client = new ProtonCalendarClient({
      baseUrl: proton.baseUrl,
      sessionStore: createSessionStore({ cookieHeader: "pm-session=expired" }),
      maxRetries: 0,
    });

    await assert.rejects(
      () => client.authStatus(),
      (error) => error?.code === "AUTH_EXPIRED" && error?.status === 401
    );
  } finally {
    await proton.close();
  }
});

function createSessionStore({ cookieHeader }) {
  return {
    async getUIDCandidates() {
      return ["uid-123"];
    },
    async getCookieHeader() {
      return cookieHeader;
    },
    async getPersistedSessions() {
      return {};
    },
  };
}
