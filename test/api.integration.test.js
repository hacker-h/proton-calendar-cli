import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startApiServer } from "../src/server.js";
import { startMockProtonServer } from "./helpers/mock-proton-server.js";

test("health endpoint responds without auth", async () => {
  const setup = await createFixture();
  try {
    const response = await fetch(`${setup.api.baseUrl}/v1/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.status, "ok");
  } finally {
    await setup.close();
  }
});

test("requires bearer auth for calendar endpoints", async () => {
  const setup = await createFixture();
  try {
    const response = await fetch(`${setup.api.baseUrl}/v1/events?start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z`);
    assert.equal(response.status, 401);
  } finally {
    await setup.close();
  }
});

test("reports upstream auth status", async () => {
  const setup = await createFixture();
  try {
    const response = await apiRequest(setup, "GET", "/v1/auth/status");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.authenticated, true);
    assert.equal(response.body.data.targetCalendarId, setup.proton.calendarId);
    assert.equal(response.body.data.session.cookieCount > 0, true);
  } finally {
    await setup.close();
  }
});

test("supports create/list/get/update/delete event lifecycle", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Design review",
      description: "Review API proposal",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
      location: "Video",
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.title, "Design review");
    const eventId = created.body.data.id;

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.events.length, 1);
    assert.equal(listed.body.data.events[0].id, eventId);

    const fetched = await apiRequest(setup, "GET", `/v1/events/${eventId}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.title, "Design review");

    const updated = await apiRequest(setup, "PATCH", `/v1/events/${eventId}`, {
      title: "Updated design review",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.title, "Updated design review");

    const deleted = await apiRequest(setup, "DELETE", `/v1/events/${eventId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.deleted, true);

    const listedAfterDelete = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(listedAfterDelete.status, 200);
    assert.equal(listedAfterDelete.body.data.events.length, 0);
  } finally {
    await setup.close();
  }
});

test("supports range filtering and pagination", async () => {
  const setup = await createFixture();
  try {
    setup.proton.addEvent({
      title: "Event A",
      start: "2026-03-12T09:00:00.000Z",
      end: "2026-03-12T10:00:00.000Z",
      timezone: "UTC",
    });
    setup.proton.addEvent({
      title: "Event B",
      start: "2026-03-12T11:00:00.000Z",
      end: "2026-03-12T12:00:00.000Z",
      timezone: "UTC",
    });
    setup.proton.addEvent({
      title: "Event C",
      start: "2026-03-12T13:00:00.000Z",
      end: "2026-03-12T14:00:00.000Z",
      timezone: "UTC",
    });

    const page1 = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-12T00:00:00.000Z&end=2026-03-13T00:00:00.000Z&limit=2"
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.events.length, 2);
    assert.equal(typeof page1.body.data.nextCursor, "string");

    const page2 = await apiRequest(
      setup,
      "GET",
      `/v1/events?start=2026-03-12T00:00:00.000Z&end=2026-03-13T00:00:00.000Z&limit=2&cursor=${page1.body.data.nextCursor}`
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.events.length, 1);
    assert.equal(page2.body.data.nextCursor, null);
  } finally {
    await setup.close();
  }
});

test("returns 404 for missing events", async () => {
  const setup = await createFixture();
  try {
    const getMissing = await apiRequest(setup, "GET", "/v1/events/missing-event");
    assert.equal(getMissing.status, 404);
    assert.equal(getMissing.body.error.code, "NOT_FOUND");

    const deleteMissing = await apiRequest(setup, "DELETE", "/v1/events/missing-event");
    assert.equal(deleteMissing.status, 404);
    assert.equal(deleteMissing.body.error.code, "NOT_FOUND");
  } finally {
    await setup.close();
  }
});

test("validates request constraints for single-instance events", async () => {
  const setup = await createFixture();
  try {
    const recurrenceAttempt = await apiRequest(setup, "POST", "/v1/events", {
      title: "Recurring",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY" },
    });
    assert.equal(recurrenceAttempt.status, 400);
    assert.equal(recurrenceAttempt.body.error.code, "SINGLE_INSTANCE_ONLY");

    const invalidRange = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-11T00:00:00.000Z&end=2026-03-10T00:00:00.000Z"
    );
    assert.equal(invalidRange.status, 400);
    assert.equal(invalidRange.body.error.code, "INVALID_TIME_RANGE");
  } finally {
    await setup.close();
  }
});

test("enforces target calendar and does not allow override", async () => {
  const setup = await createFixture();
  try {
    const response = await apiRequest(setup, "POST", "/v1/events", {
      calendarId: "other-calendar",
      title: "Cross calendar attempt",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T11:00:00.000Z",
      timezone: "UTC",
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "CALENDAR_SCOPE_VIOLATION");
  } finally {
    await setup.close();
  }
});

test("validates update payloads", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Patch me",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T11:00:00.000Z",
      timezone: "UTC",
    });

    const eventId = created.body.data.id;
    const emptyPatch = await apiRequest(setup, "PATCH", `/v1/events/${eventId}`, {});
    assert.equal(emptyPatch.status, 400);
    assert.equal(emptyPatch.body.error.code, "EMPTY_PATCH");

    const badRangePatch = await apiRequest(setup, "PATCH", `/v1/events/${eventId}`, {
      start: "2026-03-10T12:00:00.000Z",
      end: "2026-03-10T10:00:00.000Z",
    });
    assert.equal(badRangePatch.status, 400);
    assert.equal(badRangePatch.body.error.code, "INVALID_TIME_RANGE");
  } finally {
    await setup.close();
  }
});

test("reloads cookie bundle automatically after auth failure", async () => {
  const setup = await createFixture({ initialSessionCookie: "expired-cookie" });
  try {
    const first = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(first.status, 401);
    assert.equal(first.body.error.code, "AUTH_EXPIRED");

    await writeCookieBundle(setup.cookieFilePath, new URL(setup.proton.baseUrl).hostname, setup.proton.validSessionCookie);

    const second = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(second.status, 200);
  } finally {
    await setup.close();
  }
});

async function createFixture(options = {}) {
  const proton = await startMockProtonServer();
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proton-calendar-api-tests-"));
  const cookieFilePath = path.join(tmpDir, "cookies.json");
  const initialSessionCookie = options.initialSessionCookie || proton.validSessionCookie;
  await writeCookieBundle(cookieFilePath, new URL(proton.baseUrl).hostname, initialSessionCookie);

  const api = await startApiServer(
    {
      port: 8787,
      targetCalendarId: proton.calendarId,
      apiBearerToken: "test-token",
      cookieBundlePath: cookieFilePath,
      protonBaseUrl: proton.baseUrl,
      protonTimeoutMs: 3000,
      protonMaxRetries: 0,
    },
    { port: 0 }
  );

  return {
    api,
    proton,
    cookieFilePath,
    async close() {
      await Promise.all([api.close(), proton.close()]);
    },
  };
}

async function apiRequest(setup, method, route, body) {
  const response = await fetch(`${setup.api.baseUrl}${route}`, {
    method,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "X-Idempotency-Key": "test-idempotency-key",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let parsed;
  const text = await response.text();
  parsed = text ? JSON.parse(text) : null;

  return {
    status: response.status,
    body: parsed,
  };
}

async function writeCookieBundle(filePath, domain, sessionValue) {
  const payload = {
    exportedAt: new Date().toISOString(),
    source: "test",
    cookies: [
      {
        name: "pm-session",
        value: sessionValue,
        domain,
        path: "/",
        secure: false,
      },
      {
        name: "pm-auth",
        value: sessionValue,
        domain,
        path: "/",
        secure: false,
      },
    ],
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}
