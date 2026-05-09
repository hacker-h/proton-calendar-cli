import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startApiServer } from "../src/server.js";
import { ApiError } from "../src/errors.js";
import { CookieSessionStore } from "../src/session/cookie-session-store.js";

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

test("rejects wrong-content and wrong-length bearer tokens", async () => {
  const setup = await createFixture();
  try {
    for (const token of ["test-tokem", "toolong-token", "tok"]) {
      const response = await fetch(
        `${setup.api.baseUrl}/v1/events?start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      assert.equal(response.status, 401);

      const payload = await response.json();
      assert.equal(payload.error.code, "UNAUTHORIZED");
    }

    const authorized = await apiRequest(setup, "GET", "/v1/auth/status");
    assert.equal(authorized.status, 200);
  } finally {
    await setup.close();
  }
});

test("reports auth status and calendar scope configuration", async () => {
  const setup = await createFixture({
    targetCalendarId: null,
    allowedCalendarIds: ["assistant-calendar", "team-calendar"],
    defaultCalendarId: "assistant-calendar",
  });
  try {
    const response = await apiRequest(setup, "GET", "/v1/auth/status");
    assert.equal(response.status, 200);
    assert.equal(response.body.data.authenticated, true);
    assert.equal(response.body.data.targetCalendarId, null);
    assert.equal(response.body.data.defaultCalendarId, "assistant-calendar");
    assert.deepEqual(response.body.data.allowedCalendarIds, ["assistant-calendar", "team-calendar"]);
  } finally {
    await setup.close();
  }
});

test("reports unauthenticated auth status for ApiError AUTH_EXPIRED", async () => {
  const setup = await createFixture({ initialSessionCookie: "expired-cookie" });
  try {
    const status = await setup.api.service.authStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.targetCalendarId, setup.proton.primaryCalendarId);
    assert.deepEqual(status.allowedCalendarIds, [setup.proton.primaryCalendarId]);
  } finally {
    await setup.close();
  }
});

test("rethrows non-ApiError auth-expired-shaped failures unchanged", async () => {
  const upstreamError = Object.assign(new Error("network unavailable"), {
    code: "AUTH_EXPIRED",
  });
  const setup = await createFixture({ authStatusError: upstreamError });
  try {
    await assert.rejects(
      () => setup.api.service.authStatus(),
      (error) => error === upstreamError
    );
  } finally {
    await setup.close();
  }
});

test("supports legacy routes against configured default/target calendar", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Design review",
      description: "Line 1\nLine 2",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
      location: "Video, Room A; North",
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.calendarId, setup.proton.primaryCalendarId);
    assert.equal(created.body.data.description, "Line 1\nLine 2");
    assert.equal(created.body.data.location, "Video, Room A; North");

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.events.length, 1);
  } finally {
    await setup.close();
  }
});

test("supports multi-calendar explicit routes when target lock is disabled", async () => {
  const setup = await createFixture({
    targetCalendarId: null,
    allowedCalendarIds: ["assistant-calendar", "team-calendar"],
    defaultCalendarId: "assistant-calendar",
  });
  try {
    const created = await apiRequest(setup, "POST", "/v1/calendars/team-calendar/events", {
      title: "Team planning",
      start: "2026-03-10T12:00:00.000Z",
      end: "2026-03-10T13:00:00.000Z",
      timezone: "UTC",
      description: "cross-team",
      location: "HQ",
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.calendarId, "team-calendar");

    const teamList = await apiRequest(
      setup,
      "GET",
      "/v1/calendars/team-calendar/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(teamList.status, 200);
    assert.equal(teamList.body.data.events.length, 1);

    const defaultList = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(defaultList.status, 200);
    assert.equal(defaultList.body.data.events.length, 0);
  } finally {
    await setup.close();
  }
});

test("enforces hard target lock even with calendar routes", async () => {
  const setup = await createFixture({
    targetCalendarId: "assistant-calendar",
    allowedCalendarIds: ["assistant-calendar", "team-calendar"],
    defaultCalendarId: "assistant-calendar",
  });

  try {
    const response = await apiRequest(setup, "POST", "/v1/calendars/team-calendar/events", {
      title: "Blocked",
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

test("rejects calendars outside allowlist", async () => {
  const setup = await createFixture({
    targetCalendarId: null,
    allowedCalendarIds: ["assistant-calendar"],
    defaultCalendarId: "assistant-calendar",
  });

  try {
    const response = await apiRequest(
      setup,
      "GET",
      "/v1/calendars/private-calendar/events?start=2026-03-10T00:00:00.000Z&end=2026-03-11T00:00:00.000Z"
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "CALENDAR_NOT_ALLOWED");
  } finally {
    await setup.close();
  }
});

test("supports recurrence and expands instances in list responses", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Standup",
      description: "Daily sync",
      location: "Room 42",
      start: "2026-03-09T09:00:00.000Z",
      end: "2026-03-09T09:30:00.000Z",
      timezone: "UTC",
      recurrence: {
        freq: "DAILY",
        count: 3,
      },
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.recurrence.freq, "DAILY");

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-12T23:59:59.000Z"
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.events.length, 3);
    assert.equal(listed.body.data.events.every((event) => event.isRecurring), true);
    assert.equal(listed.body.data.events[0].occurrenceStart, "2026-03-09T09:00:00.000Z");
    assert.equal(listed.body.data.events[1].occurrenceStart, "2026-03-10T09:00:00.000Z");
    assert.equal(listed.body.data.events[2].occurrenceStart, "2026-03-11T09:00:00.000Z");
  } finally {
    await setup.close();
  }
});

test("exDates do not consume recurrence count budget", async () => {
  const setup = await createFixture();
  try {
    const scenarios = [
      {
        title: "Daily count no exclusions",
        recurrence: {
          freq: "DAILY",
          count: 4,
          exDates: [],
        },
        expectedStarts: [
          "2026-03-09T09:00:00.000Z",
          "2026-03-10T09:00:00.000Z",
          "2026-03-11T09:00:00.000Z",
          "2026-03-12T09:00:00.000Z",
        ],
      },
      {
        title: "Daily count some exclusions",
        recurrence: {
          freq: "DAILY",
          count: 4,
          exDates: ["2026-03-10T09:00:00.000Z", "2026-03-12T09:00:00.000Z"],
        },
        expectedStarts: [
          "2026-03-09T09:00:00.000Z",
          "2026-03-11T09:00:00.000Z",
          "2026-03-13T09:00:00.000Z",
          "2026-03-14T09:00:00.000Z",
        ],
      },
      {
        title: "Daily count all-but-one exclusions",
        recurrence: {
          freq: "DAILY",
          count: 2,
          exDates: [
            "2026-03-09T09:00:00.000Z",
            "2026-03-10T09:00:00.000Z",
            "2026-03-11T09:00:00.000Z",
          ],
        },
        expectedStarts: ["2026-03-12T09:00:00.000Z", "2026-03-13T09:00:00.000Z"],
      },
    ];

    for (const scenario of scenarios) {
      const created = await apiRequest(setup, "POST", "/v1/events", {
        title: scenario.title,
        start: "2026-03-09T09:00:00.000Z",
        end: "2026-03-09T09:30:00.000Z",
        timezone: "UTC",
        recurrence: scenario.recurrence,
      });
      assert.equal(created.status, 201);
    }

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-16T00:00:00.000Z&limit=50"
    );
    assert.equal(listed.status, 200);

    for (const scenario of scenarios) {
      const starts = listed.body.data.events
        .filter((event) => event.title === scenario.title)
        .map((event) => event.occurrenceStart);
      assert.deepEqual(starts, scenario.expectedStarts);
    }
  } finally {
    await setup.close();
  }
});

test("recurrence expansion stops when candidate iteration cap is exhausted", async () => {
  const setup = await createFixture({ recurrenceMaxIterations: 3 });
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Excluded daily series",
      start: "2026-03-09T09:00:00.000Z",
      end: "2026-03-09T09:30:00.000Z",
      timezone: "UTC",
      recurrence: {
        freq: "DAILY",
        count: 2,
        exDates: [
          "2026-03-09T09:00:00.000Z",
          "2026-03-10T09:00:00.000Z",
          "2026-03-11T09:00:00.000Z",
          "2026-03-12T09:00:00.000Z",
        ],
      },
    });
    assert.equal(created.status, 201);

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-20T00:00:00.000Z&limit=50"
    );
    assert.equal(listed.status, 422);
    assert.equal(listed.body.error.code, "RECURRENCE_ITERATION_LIMIT");
    assert.equal(listed.body.error.details.maxIterations, 3);
  } finally {
    await setup.close();
  }
});

test("near-all-excluded recurrence emits after skipped candidates before cap", async () => {
  const setup = await createFixture({ recurrenceMaxIterations: 6 });
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Mostly excluded daily series",
      start: "2026-03-09T09:00:00.000Z",
      end: "2026-03-09T09:30:00.000Z",
      timezone: "UTC",
      recurrence: {
        freq: "DAILY",
        count: 2,
        exDates: [
          "2026-03-09T09:00:00.000Z",
          "2026-03-10T09:00:00.000Z",
          "2026-03-11T09:00:00.000Z",
        ],
      },
    });
    assert.equal(created.status, 201);

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-20T00:00:00.000Z&limit=50"
    );
    assert.equal(listed.status, 200);

    const starts = listed.body.data.events
      .filter((event) => event.title === "Mostly excluded daily series")
      .map((event) => event.occurrenceStart);
    assert.deepEqual(starts, ["2026-03-12T09:00:00.000Z", "2026-03-13T09:00:00.000Z"]);
  } finally {
    await setup.close();
  }
});

test("supports pagination on expanded recurrence instances", async () => {
  const setup = await createFixture();
  try {
    await apiRequest(setup, "POST", "/v1/events", {
      title: "Recurring",
      start: "2026-03-09T09:00:00.000Z",
      end: "2026-03-09T09:15:00.000Z",
      timezone: "UTC",
      recurrence: {
        freq: "DAILY",
        count: 5,
      },
    });

    const page1 = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-15T00:00:00.000Z&limit=2"
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.events.length, 2);
    assert.equal(typeof page1.body.data.nextCursor, "string");

    const page2 = await apiRequest(
      setup,
      "GET",
      `/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-15T00:00:00.000Z&limit=2&cursor=${page1.body.data.nextCursor}`
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.body.data.events.length, 2);
  } finally {
    await setup.close();
  }
});

test("scope=single updates only one occurrence", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Daily sync",
      start: "2026-03-09T09:00:00.000Z",
      end: "2026-03-09T09:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY", count: 3 },
    });

    const seriesId = created.body.data.id;
    const secondOccurrence = "2026-03-10T09:00:00.000Z";

    const patched = await apiRequest(
      setup,
      "PATCH",
      `/v1/events/${encodeURIComponent(seriesId)}?scope=single&occurrenceStart=${encodeURIComponent(secondOccurrence)}`,
      {
        title: "Rescheduled one-off",
        description: "Custom notes",
        location: "Room B",
      }
    );

    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.title, "Rescheduled one-off");

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-12T00:00:00.000Z"
    );

    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.events.length, 3);

    const second = listed.body.data.events.find((event) => event.start === secondOccurrence);
    assert.ok(second);
    assert.equal(second.title, "Rescheduled one-off");

    const first = listed.body.data.events.find((event) => event.start === "2026-03-09T09:00:00.000Z");
    const third = listed.body.data.events.find((event) => event.start === "2026-03-11T09:00:00.000Z");
    assert.equal(first.title, "Daily sync");
    assert.equal(third.title, "Daily sync");
  } finally {
    await setup.close();
  }
});

test("scope=following updates this and all future occurrences", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Ops sync",
      start: "2026-03-09T10:00:00.000Z",
      end: "2026-03-09T10:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY", count: 5 },
    });

    const seriesId = created.body.data.id;
    const splitStart = "2026-03-11T10:00:00.000Z";

    const patched = await apiRequest(
      setup,
      "PATCH",
      `/v1/events/${encodeURIComponent(seriesId)}?scope=following&occurrenceStart=${encodeURIComponent(splitStart)}`,
      {
        title: "Ops sync v2",
      }
    );

    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.title, "Ops sync v2");

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-16T00:00:00.000Z"
    );
    assert.equal(listed.status, 200);

    const oldSeriesDays = listed.body.data.events.filter((event) => event.start < splitStart);
    const newSeriesDays = listed.body.data.events.filter((event) => event.start >= splitStart);
    assert.equal(oldSeriesDays.length >= 2, true);
    assert.equal(oldSeriesDays.every((event) => event.title === "Ops sync"), true);
    assert.equal(newSeriesDays.length >= 1, true);
    assert.equal(newSeriesDays.every((event) => event.title === "Ops sync v2"), true);
  } finally {
    await setup.close();
  }
});

test("scope=series updates whole recurring series", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Project sync",
      start: "2026-03-09T11:00:00.000Z",
      end: "2026-03-09T11:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY", count: 3 },
    });

    const seriesId = created.body.data.id;
    const patched = await apiRequest(setup, "PATCH", `/v1/events/${encodeURIComponent(seriesId)}?scope=series`, {
      title: "Project sync updated",
      location: "New room",
    });

    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.title, "Project sync updated");

    const listed = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-12T23:59:59.000Z"
    );

    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.events.length, 3);
    assert.equal(listed.body.data.events.every((event) => event.title === "Project sync updated"), true);
  } finally {
    await setup.close();
  }
});

test("delete supports single, following, and series scopes", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Delete scopes",
      start: "2026-03-09T12:00:00.000Z",
      end: "2026-03-09T12:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY", count: 5 },
    });

    const seriesId = created.body.data.id;

    const singleDeleted = await apiRequest(
      setup,
      "DELETE",
      `/v1/events/${encodeURIComponent(seriesId)}?scope=single&occurrenceStart=${encodeURIComponent("2026-03-10T12:00:00.000Z")}`
    );
    assert.equal(singleDeleted.status, 200);

    const followingDeleted = await apiRequest(
      setup,
      "DELETE",
      `/v1/events/${encodeURIComponent(seriesId)}?scope=following&occurrenceStart=${encodeURIComponent("2026-03-12T12:00:00.000Z")}`
    );
    assert.equal(followingDeleted.status, 200);

    const afterFollowing = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-15T00:00:00.000Z"
    );
    assert.equal(afterFollowing.status, 200);
    assert.equal(afterFollowing.body.data.events.some((event) => event.start === "2026-03-10T12:00:00.000Z"), false);
    assert.equal(afterFollowing.body.data.events.some((event) => event.start >= "2026-03-12T12:00:00.000Z"), false);

    const seriesDeleted = await apiRequest(setup, "DELETE", `/v1/events/${encodeURIComponent(seriesId)}?scope=series`);
    assert.equal(seriesDeleted.status, 200);

    const finalList = await apiRequest(
      setup,
      "GET",
      "/v1/events?start=2026-03-09T00:00:00.000Z&end=2026-03-15T00:00:00.000Z"
    );
    assert.equal(finalList.status, 200);
    assert.equal(finalList.body.data.events.length, 0);
  } finally {
    await setup.close();
  }
});

test("validates recurrence constraints and scope requirements", async () => {
  const setup = await createFixture();
  try {
    const badRecurrence = await apiRequest(setup, "POST", "/v1/events", {
      title: "Bad recurrence",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "HOURLY" },
    });
    assert.equal(badRecurrence.status, 400);
    assert.equal(badRecurrence.body.error.code, "INVALID_RECURRENCE");

    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Good recurrence",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
      recurrence: { freq: "DAILY", count: 3 },
    });
    const seriesId = created.body.data.id;

    const missingOccurrence = await apiRequest(
      setup,
      "PATCH",
      `/v1/events/${encodeURIComponent(seriesId)}?scope=single`,
      { title: "No start" }
    );
    assert.equal(missingOccurrence.status, 400);
    assert.equal(missingOccurrence.body.error.code, "OCCURRENCE_START_REQUIRED");

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

test("POST without protected defaults to protected: true", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "No protected field",
      start: "2026-03-10T10:00:00.000Z",
      end: "2026-03-10T10:30:00.000Z",
      timezone: "UTC",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.protected, true);
  } finally {
    await setup.close();
  }
});

test("POST accepts all-day date-only payloads and normalizes them to timezone boundaries", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Holiday",
      start: "2026-04-09",
      end: "2026-04-10",
      timezone: "Europe/Berlin",
      allDay: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.allDay, true);
    assert.equal(created.body.data.start, "2026-04-08T22:00:00.000Z");
    assert.equal(created.body.data.end, "2026-04-09T22:00:00.000Z");
  } finally {
    await setup.close();
  }
});

test("POST with protected: false returns protected: false", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Explicit unprotected",
      start: "2026-03-10T11:00:00.000Z",
      end: "2026-03-10T11:30:00.000Z",
      timezone: "UTC",
      protected: false,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.protected, false);
  } finally {
    await setup.close();
  }
});

test("POST with protected: true returns protected: true", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Protected event",
      start: "2026-03-10T12:00:00.000Z",
      end: "2026-03-10T12:30:00.000Z",
      timezone: "UTC",
      protected: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.protected, true);
  } finally {
    await setup.close();
  }
});

test("POST with protected as string rejects with 400 INVALID_FIELD", async () => {
  const setup = await createFixture();
  try {
    const result = await apiRequest(setup, "POST", "/v1/events", {
      title: "Bad protected type",
      start: "2026-03-10T13:00:00.000Z",
      end: "2026-03-10T13:30:00.000Z",
      timezone: "UTC",
      protected: "false",
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_FIELD");
  } finally {
    await setup.close();
  }
});

test("POST with protected as number rejects with 400 INVALID_FIELD", async () => {
  const setup = await createFixture();
  try {
    const result = await apiRequest(setup, "POST", "/v1/events", {
      title: "Bad protected type",
      start: "2026-03-10T14:00:00.000Z",
      end: "2026-03-10T14:30:00.000Z",
      timezone: "UTC",
      protected: 0,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_FIELD");
  } finally {
    await setup.close();
  }
});

test("PATCH with protected: true updates event to protected", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Patchable event",
      start: "2026-03-10T15:00:00.000Z",
      end: "2026-03-10T15:30:00.000Z",
      timezone: "UTC",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.protected, true);

    const eventId = created.body.data.id;
    const patched = await apiRequest(setup, "PATCH", `/v1/events/${encodeURIComponent(eventId)}`, {
      protected: true,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.protected, true);

    const patchedFalse = await apiRequest(setup, "PATCH", `/v1/events/${encodeURIComponent(eventId)}`, {
      protected: false,
    });
    assert.equal(patchedFalse.status, 200);
    assert.equal(patchedFalse.body.data.protected, false);
  } finally {
    await setup.close();
  }
});

test("PATCH can switch an event to all-day mode", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Timed event",
      start: "2026-04-09T09:00:00.000Z",
      end: "2026-04-09T10:00:00.000Z",
      timezone: "Europe/Berlin",
    });

    const updated = await apiRequest(setup, "PATCH", `/v1/events/${encodeURIComponent(created.body.data.id)}`, {
      start: "2026-04-09",
      end: "2026-04-10",
      timezone: "Europe/Berlin",
      allDay: true,
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.allDay, true);
    assert.equal(updated.body.data.start, "2026-04-08T22:00:00.000Z");
    assert.equal(updated.body.data.end, "2026-04-09T22:00:00.000Z");
  } finally {
    await setup.close();
  }
});

test("PATCH with protected as string rejects with 400 INVALID_FIELD", async () => {
  const setup = await createFixture();
  try {
    const created = await apiRequest(setup, "POST", "/v1/events", {
      title: "Patch validation",
      start: "2026-03-10T16:00:00.000Z",
      end: "2026-03-10T16:30:00.000Z",
      timezone: "UTC",
    });
    assert.equal(created.status, 201);

    const eventId = created.body.data.id;
    const result = await apiRequest(setup, "PATCH", `/v1/events/${encodeURIComponent(eventId)}`, {
      protected: "true",
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_FIELD");
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
  const calendarIds = options.calendarIds || ["assistant-calendar", "team-calendar"];
  const protonBaseUrl = "http://127.0.0.1:9999";

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "proton-calendar-api-tests-"));
  const cookieFilePath = path.join(tmpDir, "cookies.json");
  const sessionStore = new CookieSessionStore({ cookieBundlePath: cookieFilePath });
  const proton = createMockProtonClient({
    sessionStore,
    baseUrl: protonBaseUrl,
    calendarIds,
    authStatusError: options.authStatusError,
  });

  const initialSessionCookie = options.initialSessionCookie || proton.validSessionCookie;
  await writeCookieBundle(cookieFilePath, new URL(proton.baseUrl).hostname, initialSessionCookie);

  const targetCalendarId = options.targetCalendarId === undefined ? proton.primaryCalendarId : options.targetCalendarId;
  const allowedCalendarIds = options.allowedCalendarIds || [proton.primaryCalendarId];
  const defaultCalendarId = options.defaultCalendarId || targetCalendarId || allowedCalendarIds[0];

  const api = await startApiServer(
    {
      port: 8787,
      targetCalendarId,
      defaultCalendarId,
      allowedCalendarIds,
      apiBearerToken: "test-token",
      cookieBundlePath: cookieFilePath,
      protonBaseUrl: proton.baseUrl,
      protonTimeoutMs: 3000,
      protonMaxRetries: 0,
      recurrenceMaxIterations: options.recurrenceMaxIterations,
    },
    { port: 0, protonClient: proton.client, sessionStore }
  );

  return {
    api,
    proton,
    cookieFilePath,
    async close() {
      await Promise.all([api.close()]);
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

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

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

function createMockProtonClient(options) {
  const validSessionCookie = "valid-session";
  const baseUrl = options.baseUrl;
  const sessionStore = options.sessionStore;
  const calendarIds = options.calendarIds;
  const primaryCalendarId = calendarIds[0];

  const calendarStores = new Map();
  for (const calendarId of calendarIds) {
    calendarStores.set(calendarId, new Map());
  }

  let nextId = 1;

  async function assertAuthorized() {
    const cookieHeader = await sessionStore.getCookieHeader(`${baseUrl}/api/core/v4/users`);
    const cookies = cookieHeader.split(";").map((value) => value.trim());
    const authorized = cookies.some((value) => value === `pm-session=${validSessionCookie}`);
    if (!authorized) {
      throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized");
    }
  }

  function readCalendarStore(calendarId) {
    const store = calendarStores.get(calendarId);
    if (!store) {
      throw new ApiError(404, "NOT_FOUND", "Resource not found");
    }
    return store;
  }

  const client = {
    async authStatus() {
      if (options.authStatusError) {
        throw options.authStatusError;
      }
      await assertAuthorized();
      return { ok: true, account: "assistant" };
    },

    async listEvents({ calendarId, limit, cursor }) {
      await assertAuthorized();
      const store = readCalendarStore(calendarId);
      const offset = Number(cursor || "0");
      const all = [...store.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const page = all.slice(offset, offset + limit);
      const nextCursor = offset + limit < all.length ? String(offset + limit) : null;
      return {
        events: page.map((event) => ({ ...event, recurrence: cloneRecurrence(event.recurrence) })),
        nextCursor,
      };
    },

    async getEvent({ calendarId, eventId }) {
      await assertAuthorized();
      const store = readCalendarStore(calendarId);
      const event = store.get(eventId);
      if (!event) {
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      }
      return {
        ...event,
        recurrence: cloneRecurrence(event.recurrence),
      };
    },

    async createEvent({ calendarId, event }) {
      await assertAuthorized();
      const store = readCalendarStore(calendarId);
      const now = new Date().toISOString();
      const id = `evt-${nextId}`;
      nextId += 1;

      const record = {
        id,
        calendarId,
        title: event.title,
        description: event.description || "",
        start: event.start,
        end: event.end,
        allDay: event.allDay ?? false,
        timezone: event.timezone,
        location: event.location || "",
        protected: event.protected ?? false,
        recurrence: cloneRecurrence(event.recurrence),
        seriesId: null,
        occurrenceStart: null,
        createdAt: now,
        updatedAt: now,
      };

      store.set(id, record);
      return { ...record, recurrence: cloneRecurrence(record.recurrence) };
    },

    async updateEvent({ calendarId, eventId, patch, scope, occurrenceStart }) {
      await assertAuthorized();
      const store = readCalendarStore(calendarId);
      const existing = store.get(eventId);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      }

      if (scope === "series" || !existing.recurrence) {
        const updated = applyPatch(existing, patch);
        store.set(eventId, updated);
        return { ...updated, recurrence: cloneRecurrence(updated.recurrence) };
      }

      if (scope === "single") {
        const targetOccurrence = normalizeIso(occurrenceStart);
        if (Date.parse(targetOccurrence) < Date.parse(existing.start)) {
          throw new ApiError(400, "INVALID_TIME_RANGE", "occurrenceStart must be within series");
        }

        ensureExDate(existing, targetOccurrence);

        let detached = findDetachedOccurrence(store, eventId, targetOccurrence);
        if (!detached) {
          const durationMs = Date.parse(existing.end) - Date.parse(existing.start);
          detached = {
            id: `ovr-${nextId}`,
            calendarId,
            title: existing.title,
            description: existing.description,
            start: targetOccurrence,
            end: new Date(Date.parse(targetOccurrence) + durationMs).toISOString(),
            timezone: existing.timezone,
            location: existing.location,
            protected: existing.protected ?? false,
            recurrence: null,
            seriesId: eventId,
            occurrenceStart: targetOccurrence,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          nextId += 1;
        }

        detached = applyPatch(detached, patch);
        detached.recurrence = null;
        detached.seriesId = eventId;
        detached.occurrenceStart = targetOccurrence;
        store.set(detached.id, detached);
        store.set(eventId, { ...existing, recurrence: cloneRecurrence(existing.recurrence), updatedAt: new Date().toISOString() });
        return { ...detached, recurrence: null };
      }

      if (scope === "following") {
        const splitStart = normalizeIso(occurrenceStart);
        if (Date.parse(splitStart) < Date.parse(existing.start)) {
          throw new ApiError(400, "INVALID_TIME_RANGE", "occurrenceStart must be within series");
        }

        const priorRecurrence = cloneRecurrence(existing.recurrence);

        existing.recurrence.until = new Date(Date.parse(splitStart) - 1000).toISOString();
        if (existing.recurrence.count !== null) {
          existing.recurrence.count = null;
        }
        existing.recurrence.exDates = (existing.recurrence.exDates || []).filter((value) => Date.parse(value) < Date.parse(splitStart));
        existing.updatedAt = new Date().toISOString();
        store.set(eventId, existing);

        removeDetachedAtOrAfter(store, eventId, splitStart);

        const durationMs = Date.parse(existing.end) - Date.parse(existing.start);
        const start = patch.start || splitStart;
        const end = patch.end || new Date(Date.parse(start) + durationMs).toISOString();
        const newSeries = {
          id: `evt-${nextId}`,
          calendarId,
          title: patch.title ?? existing.title,
          description: patch.description ?? existing.description,
          start,
          end,
          timezone: patch.timezone ?? existing.timezone,
          location: patch.location ?? existing.location,
          protected: patch.protected ?? existing.protected ?? false,
          recurrence: cloneRecurrence(patch.recurrence ?? priorRecurrence),
          seriesId: null,
          occurrenceStart: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        nextId += 1;
        store.set(newSeries.id, newSeries);
        return { ...newSeries, recurrence: cloneRecurrence(newSeries.recurrence) };
      }

      throw new ApiError(400, "INVALID_SCOPE", "Unsupported scope");
    },

    async deleteEvent({ calendarId, eventId, scope, occurrenceStart }) {
      await assertAuthorized();
      const store = readCalendarStore(calendarId);
      const existing = store.get(eventId);
      if (!existing) {
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      }

      if (scope === "series" || !existing.recurrence) {
        store.delete(eventId);
        for (const [id, item] of store.entries()) {
          if (item.seriesId === eventId) {
            store.delete(id);
          }
        }
        return null;
      }

      if (scope === "single") {
        const targetOccurrence = normalizeIso(occurrenceStart);
        ensureExDate(existing, targetOccurrence);
        store.set(eventId, existing);

        const detached = findDetachedOccurrence(store, eventId, targetOccurrence);
        if (detached) {
          store.delete(detached.id);
        }
        return null;
      }

      if (scope === "following") {
        const splitStart = normalizeIso(occurrenceStart);
        existing.recurrence.until = new Date(Date.parse(splitStart) - 1000).toISOString();
        if (existing.recurrence.count !== null) {
          existing.recurrence.count = null;
        }
        existing.updatedAt = new Date().toISOString();
        store.set(eventId, existing);
        removeDetachedAtOrAfter(store, eventId, splitStart);
        return null;
      }

      throw new ApiError(400, "INVALID_SCOPE", "Unsupported scope");
    },
  };

  return {
    calendarIds,
    primaryCalendarId,
    validSessionCookie,
    baseUrl,
    client,
  };
}

function applyPatch(event, patch) {
  const updated = {
    ...event,
    updatedAt: new Date().toISOString(),
  };

  if (patch.title !== undefined) {
    updated.title = patch.title;
  }
  if (patch.description !== undefined) {
    updated.description = patch.description;
  }
  if (patch.location !== undefined) {
    updated.location = patch.location;
  }
  if (patch.timezone !== undefined) {
    updated.timezone = patch.timezone;
  }

  const previousDuration = Date.parse(event.end) - Date.parse(event.start);
  if (patch.start !== undefined && patch.end === undefined) {
    updated.start = patch.start;
    updated.end = new Date(Date.parse(patch.start) + previousDuration).toISOString();
  }
  if (patch.end !== undefined && patch.start === undefined) {
    updated.end = patch.end;
  }
  if (patch.start !== undefined && patch.end !== undefined) {
    updated.start = patch.start;
    updated.end = patch.end;
  }
  if (patch.allDay !== undefined) {
    updated.allDay = patch.allDay;
  }

  if (patch.recurrence !== undefined) {
    updated.recurrence = cloneRecurrence(patch.recurrence);
  }
  if (patch.protected !== undefined) {
    updated.protected = patch.protected;
  }

  return updated;
}

function ensureExDate(event, occurrenceStart) {
  if (!event.recurrence) {
    return;
  }
  if (!Array.isArray(event.recurrence.exDates)) {
    event.recurrence.exDates = [];
  }
  if (!event.recurrence.exDates.includes(occurrenceStart)) {
    event.recurrence.exDates.push(occurrenceStart);
    event.recurrence.exDates.sort();
  }
}

function findDetachedOccurrence(store, seriesId, occurrenceStart) {
  for (const item of store.values()) {
    if (item.seriesId === seriesId && item.occurrenceStart === occurrenceStart) {
      return item;
    }
  }
  return null;
}

function removeDetachedAtOrAfter(store, seriesId, splitStart) {
  for (const [id, item] of store.entries()) {
    if (item.seriesId !== seriesId) {
      continue;
    }
    if (!item.occurrenceStart) {
      continue;
    }
    if (Date.parse(item.occurrenceStart) >= Date.parse(splitStart)) {
      store.delete(id);
    }
  }
}

function cloneRecurrence(recurrence) {
  if (!recurrence || typeof recurrence !== "object") {
    return null;
  }

  return {
    freq: recurrence.freq,
    interval: recurrence.interval,
    count: recurrence.count,
    until: recurrence.until,
    byDay: Array.isArray(recurrence.byDay) ? [...recurrence.byDay] : [],
    byMonthDay: Array.isArray(recurrence.byMonthDay) ? [...recurrence.byMonthDay] : [],
    weekStart: recurrence.weekStart || null,
    exDates: Array.isArray(recurrence.exDates) ? [...recurrence.exDates] : [],
  };
}

function normalizeIso(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiError(400, "INVALID_PAYLOAD", "occurrenceStart must be an ISO date-time string");
  }
  return new Date(parsed).toISOString();
}
