import test from "node:test";
import assert from "node:assert/strict";
import {
  apiRequest,
  buildCollectionRoute,
  buildEventRoute,
  buildEventTitle,
  cleanupEvents,
  readLiveConfig,
  waitForApi,
} from "./helpers/live-test-utils.js";

const config = readLiveConfig();
const RANGE_START = "2026-03-01T00:00:00.000Z";
const RANGE_END = "2026-04-01T00:00:00.000Z";

test("live api suite", { skip: !config.enabled ? "PC_API_BASE_URL and PC_API_TOKEN are required" : false }, async (t) => {
  await waitForApi(config);
  await cleanupEvents(config, RANGE_START, RANGE_END);

  try {
    await t.test("auth status succeeds", async () => {
      const auth = await apiRequest(config, "GET", "/v1/auth/status");
      assert.equal(auth.status, 200);
      assert.equal(auth.body.data.authenticated, true);
      assert.equal(auth.body.data.defaultCalendarId, config.calendarId);
    });

    await t.test("list supports generic route, scoped route, and pagination", async () => {
      const title = buildEventTitle(config, "pagination");
      const createA = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: `${title}-a`,
        start: "2026-03-05T08:00:00.000Z",
        end: "2026-03-05T08:30:00.000Z",
        timezone: "UTC",
      });
      const createB = await apiRequest(config, "POST", buildCollectionRoute(config, undefined, { useCalendarRoute: false }), {
        title: `${title}-b`,
        start: "2026-03-05T09:00:00.000Z",
        end: "2026-03-05T09:30:00.000Z",
        timezone: "UTC",
      });
      assert.equal(createA.status, 201);
      assert.equal(createB.status, 201);

      const scopedList = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, { start: "2026-03-05T00:00:00.000Z", end: "2026-03-06T00:00:00.000Z", limit: 1 })
      );
      assert.equal(scopedList.status, 200);
      assert.equal(Array.isArray(scopedList.body.data.events), true);
      assert.equal(scopedList.body.data.events.length, 1);
      assert.equal(typeof scopedList.body.data.nextCursor, "string");

      const genericList = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(
          config,
          {
            start: "2026-03-05T00:00:00.000Z",
            end: "2026-03-06T00:00:00.000Z",
            cursor: scopedList.body.data.nextCursor,
            limit: 5,
          },
          { useCalendarRoute: false }
        )
      );
      assert.equal(genericList.status, 200);
      assert.equal(genericList.body.data.events.some((event) => String(event.title).startsWith(title)), true);
    });

    await t.test("validation errors return 400", async () => {
      const invalid = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: buildEventTitle(config, "invalid"),
        start: "2026-03-05T10:00:00.000Z",
        end: "2026-03-05T09:00:00.000Z",
        timezone: "UTC",
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_TIME_RANGE");
    });

    await t.test("timed UTC event round trips protected, notifications, and clearable fields", async () => {
      const title = buildEventTitle(config, "timed-utc");
      const created = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        description: "live api timed utc description",
        location: "UTC room",
        start: "2026-03-18T08:00:00.000Z",
        end: "2026-03-18T08:45:00.000Z",
        timezone: "UTC",
        protected: false,
        notifications: null,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.title, title);
      assert.equal(created.body.data.description, "live api timed utc description");
      assert.equal(created.body.data.location, "UTC room");
      assert.equal(created.body.data.timezone, "UTC");
      assert.equal(created.body.data.allDay, false);
      assert.equal(created.body.data.protected, false);
      assert.equal(created.body.data.notifications, null);

      const eventId = created.body.data.id;
      const fetched = await apiRequest(config, "GET", buildEventRoute(config, eventId));
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.data.title, title);
      assert.equal(fetched.body.data.protected, false);

      const patched = await apiRequest(config, "PATCH", buildEventRoute(config, eventId), {
        description: "patched live api description",
        location: "Patched UTC room",
        notifications: null,
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.data.description, "patched live api description");
      assert.equal(patched.body.data.location, "Patched UTC room");
      assert.equal(patched.body.data.protected, false);
      assert.equal(patched.body.data.notifications, null);

      const cleared = await apiRequest(config, "PATCH", buildEventRoute(config, eventId), {
        description: "",
        location: "",
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.data.description, "");
      assert.equal(cleared.body.data.location, "");
    });

    await t.test("timed Europe/Berlin event keeps timezone metadata", async () => {
      const title = buildEventTitle(config, "timed-berlin");
      const created = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        description: "live api berlin timezone",
        location: "Berlin room",
        start: "2026-03-19T08:00:00.000Z",
        end: "2026-03-19T08:30:00.000Z",
        timezone: "Europe/Berlin",
        notifications: null,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.title, title);
      assert.equal(created.body.data.timezone, "Europe/Berlin");
      assert.equal(created.body.data.start, "2026-03-19T08:00:00.000Z");
      assert.equal(created.body.data.end, "2026-03-19T08:30:00.000Z");
      assert.equal(created.body.data.protected, true);

      const listed = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, {
          start: "2026-03-19T00:00:00.000Z",
          end: "2026-03-20T00:00:00.000Z",
          limit: 50,
        })
      );
      assert.equal(listed.status, 200);
      const match = findLiveEvent(listed.body.data.events, title);
      assert.equal(match.timezone, "Europe/Berlin");
      assert.equal(match.allDay, false);
    });

    await t.test("native all-day date-only event lists with UTC midnight boundaries", async () => {
      const title = buildEventTitle(config, "all-day-utc");
      const created = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        description: "live api all-day",
        location: "All-day room",
        start: "2026-03-23",
        end: "2026-03-24",
        timezone: "UTC",
        allDay: true,
        notifications: null,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.allDay, true);
      assert.equal(created.body.data.start, "2026-03-23T00:00:00.000Z");
      assert.equal(created.body.data.end, "2026-03-24T00:00:00.000Z");

      const listed = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, {
          start: "2026-03-22T00:00:00.000Z",
          end: "2026-03-25T00:00:00.000Z",
          limit: 50,
        })
      );
      assert.equal(listed.status, 200);
      const match = findLiveEvent(listed.body.data.events, title);
      assert.equal(match.allDay, true);
      assert.equal(match.timezone, "UTC");
      assert.equal(match.start, "2026-03-23T00:00:00.000Z");
      assert.equal(match.end, "2026-03-24T00:00:00.000Z");
    });

    await t.test("single event supports create get patch delete on both route styles", async () => {
      const title = buildEventTitle(config, "crud");
      const created = await apiRequest(config, "POST", buildCollectionRoute(config, undefined, { useCalendarRoute: false }), {
        title,
        description: "gitlab live crud",
        location: "CI room",
        start: "2026-03-20T14:00:00.000Z",
        end: "2026-03-20T14:45:00.000Z",
        timezone: "UTC",
      });
      assert.equal(created.status, 201);

      const eventId = created.body.data.id;
      const fetched = await apiRequest(config, "GET", buildEventRoute(config, eventId));
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.data.title, title);

      const updatedTitle = buildEventTitle(config, "crud-updated");
      const updated = await apiRequest(
        config,
        "PATCH",
        buildEventRoute(config, eventId, { scope: "series" }, { useCalendarRoute: false }),
        {
          title: updatedTitle,
          description: "updated by gitlab",
          location: "CI updated",
        }
      );
      assert.equal(updated.status, 200);
      assert.equal(updated.body.data.title, updatedTitle);

      const removed = await apiRequest(config, "DELETE", buildEventRoute(config, eventId, { scope: "series" }));
      assert.equal(removed.status, 200);

      const missing = await apiRequest(config, "GET", buildEventRoute(config, eventId));
      assert.equal([404, 422].includes(missing.status), true);
    });

    await t.test("recurring event supports occurrence lookup and scoped mutations", async () => {
      const recurringTitle = buildEventTitle(config, "recurring");
      const recurring = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: recurringTitle,
        description: "gitlab live recurrence",
        location: "CI",
        start: "2026-03-10T09:00:00.000Z",
        end: "2026-03-10T09:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "DAILY",
          count: 4,
        },
      });
      assert.equal(recurring.status, 201);

      const recurringId = recurring.body.data.id;
      const recurringList = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, {
          start: "2026-03-10T00:00:00.000Z",
          end: "2026-03-15T00:00:00.000Z",
          limit: 50,
        })
      );
      assert.equal(recurringList.status, 200);
      const recurringMatches = recurringList.body.data.events.filter((event) => event.title === recurringTitle);
      assert.equal(recurringMatches.length >= 4, true);

      const occurrenceId = recurringMatches.find((event) => event.id !== recurringId)?.id;
      assert.equal(typeof occurrenceId, "string");

      const occurrence = await apiRequest(config, "GET", buildEventRoute(config, occurrenceId));
      assert.equal(occurrence.status, 200);
      assert.equal(occurrence.body.data.seriesId, recurringId);

      const singlePatch = await apiRequest(
        config,
        "PATCH",
        buildEventRoute(config, recurringId, {
          scope: "single",
          occurrenceStart: "2026-03-11T09:00:00.000Z",
        }),
        {
          title: buildEventTitle(config, "single-edit"),
          location: "CI single",
        }
      );
      assert.equal(singlePatch.status, 200);

      const followingPatch = await apiRequest(
        config,
        "PATCH",
        buildEventRoute(config, recurringId, {
          scope: "following",
          occurrenceStart: "2026-03-12T09:00:00.000Z",
        }),
        {
          title: buildEventTitle(config, "following-edit"),
        }
      );
      assert.equal(followingPatch.status, 200);

      const detachedDelete = await apiRequest(
        config,
        "DELETE",
        buildEventRoute(config, recurringId, {
          scope: "single",
          occurrenceStart: "2026-03-10T09:00:00.000Z",
        })
      );
      assert.equal(detachedDelete.status, 200);
    });

    await t.test("series delete works on a fresh recurring series", async () => {
      const title = buildEventTitle(config, "series-delete");
      const recurring = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        start: "2026-03-24T12:00:00.000Z",
        end: "2026-03-24T12:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "DAILY",
          count: 3,
        },
      });
      assert.equal(recurring.status, 201);

      const deleteSeries = await apiRequest(
        config,
        "DELETE",
        buildEventRoute(config, recurring.body.data.id, { scope: "series" })
      );
      assert.equal(deleteSeries.status, 200);
    });
  } finally {
    await cleanupEvents(config, RANGE_START, RANGE_END);
  }
});

function findLiveEvent(events, title) {
  const match = events.find((event) => event.title === title);
  assert.ok(match, `expected live event ${title} in list response`);
  return match;
}
