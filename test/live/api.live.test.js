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

    await t.test("list supports date ranges, pagination, and calendar-scoped routes", async () => {
      const title = buildEventTitle(config, "list-api");
      const fixtures = [
        [`${title}-a`, "2026-03-05T08:00:00.000Z", "2026-03-05T08:30:00.000Z"],
        [`${title}-b`, "2026-03-05T09:00:00.000Z", "2026-03-05T09:30:00.000Z"],
        [`${title}-outside`, "2026-03-06T09:00:00.000Z", "2026-03-06T09:30:00.000Z"],
      ];

      for (const [eventTitle, start, end] of fixtures) {
        const created = await apiRequest(config, "POST", buildCollectionRoute(config), {
          title: eventTitle,
          start,
          end,
          timezone: "UTC",
        });
        assert.equal(created.status, 201);
      }

      const paged = await collectPagedLiveTitles(config, title, {
        start: "2026-03-05T00:00:00.000Z",
        end: "2026-03-06T00:00:00.000Z",
      });
      assert.equal(paged.sawCursor, true);
      assert.deepEqual(paged.titles, [`${title}-a`, `${title}-b`]);

      const genericList = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(
          config,
          { start: "2026-03-05T00:00:00.000Z", end: "2026-03-07T00:00:00.000Z", limit: 50 },
          { useCalendarRoute: false }
        )
      );
      assert.equal(genericList.status, 200);
      assert.deepEqual(liveTitles(genericList.body.data.events, title), [`${title}-a`, `${title}-b`, `${title}-outside`]);

      const dateRange = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, { start: "2026-03-06T00:00:00.000Z", end: "2026-03-07T00:00:00.000Z", limit: 50 })
      );
      assert.equal(dateRange.status, 200);
      assert.deepEqual(liveTitles(dateRange.body.data.events, title), [`${title}-outside`]);
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

    await t.test("invalid recurrence payloads return stable validation errors", async () => {
      const badFrequency = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: buildEventTitle(config, "invalid-recurrence-frequency"),
        start: "2026-03-06T10:00:00.000Z",
        end: "2026-03-06T10:30:00.000Z",
        timezone: "UTC",
        recurrence: { freq: "HOURLY" },
      });
      assert.equal(badFrequency.status, 400);
      assert.equal(badFrequency.body.error.code, "INVALID_RECURRENCE");

      const badWeeklyByDay = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: buildEventTitle(config, "invalid-weekly-byday"),
        start: "2026-03-06T11:00:00.000Z",
        end: "2026-03-06T11:30:00.000Z",
        timezone: "UTC",
        recurrence: { freq: "WEEKLY", byDay: ["+1MO"] },
      });
      assert.equal(badWeeklyByDay.status, 400);
      assert.equal(badWeeklyByDay.body.error.code, "INVALID_RECURRENCE");
    });

    await t.test("notification validation rejects more than ten reminders", async () => {
      const tooManyNotifications = Array.from({ length: 11 }, (_value, index) => ({
        Type: 1,
        Trigger: `-PT${index + 1}M`,
      }));
      const invalid = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: buildEventTitle(config, "invalid-notifications-max"),
        start: "2026-03-06T12:00:00.000Z",
        end: "2026-03-06T12:30:00.000Z",
        timezone: "UTC",
        notifications: tooManyNotifications,
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "INVALID_NOTIFICATIONS");
    });

    await t.test("ICS import and export round trip through API", async () => {
      const title = buildEventTitle(config, "ics-api-import");
      const route = config.calendarId
        ? `/v1/calendars/${encodeURIComponent(config.calendarId)}/ics`
        : "/v1/events/ics";
      const importResponse = await fetch(`${config.apiBaseUrl}${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          Accept: "application/json",
          "Content-Type": "text/calendar; charset=utf-8",
        },
        body: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:live-api-import@example.test",
          `SUMMARY:${title}`,
          "DESCRIPTION:live api ics import",
          "LOCATION:ICS API",
          "DTSTART:20260308T100000Z",
          "DTEND:20260308T103000Z",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      });
      const imported = await importResponse.json();
      assert.equal(importResponse.status, 201);
      assert.equal(imported.data.imported, 1);
      assert.equal(imported.data.events[0].title, title);

      const exportResponse = await fetch(`${config.apiBaseUrl}${route}?start=2026-03-08T00%3A00%3A00.000Z&end=2026-03-09T00%3A00%3A00.000Z`, {
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          Accept: "text/calendar",
        },
      });
      const exported = await exportResponse.text();
      assert.equal(exportResponse.status, 200);
      assert.match(exported, /BEGIN:VCALENDAR/);
      assert.match(exported, new RegExp(escapeRegExp(title)));
      assert.equal(exported.includes(config.apiToken), false);
    });

    await t.test("notifications create preserve and clear through API mutations", async () => {
      const title = buildEventTitle(config, "notifications-api");
      const notifications = [{ Type: 1, Trigger: "-PT10M" }];
      const created = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        description: "live api notifications",
        location: "Reminder room",
        start: "2026-03-07T09:00:00.000Z",
        end: "2026-03-07T09:30:00.000Z",
        timezone: "UTC",
        notifications,
      });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body.data.notifications, notifications);

      const eventId = created.body.data.id;
      const renamed = await apiRequest(config, "PATCH", buildEventRoute(config, eventId), {
        title: buildEventTitle(config, "notifications-api-renamed"),
      });
      assert.equal(renamed.status, 200);
      assert.deepEqual(renamed.body.data.notifications, notifications);

      const listed = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, {
          start: "2026-03-07T00:00:00.000Z",
          end: "2026-03-08T00:00:00.000Z",
          limit: 50,
        })
      );
      assert.equal(listed.status, 200);
      assert.deepEqual(findLiveEvent(listed.body.data.events, renamed.body.data.title).notifications, notifications);

      const friendly = await apiRequest(config, "PATCH", buildEventRoute(config, eventId), {
        reminders: "5m,1h",
      });
      assert.equal(friendly.status, 200);
      assert.deepEqual(friendly.body.data.notifications, [
        { Type: 1, Trigger: "-PT5M" },
        { Type: 1, Trigger: "-PT1H" },
      ]);

      const cleared = await apiRequest(config, "PATCH", buildEventRoute(config, eventId), {
        notifications: null,
      });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.data.notifications, null);
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

    await t.test("recurrence matrix covers frequency options and supported rule fields", async () => {
      const dailyTitle = buildEventTitle(config, "recur-daily-interval-exdate");
      const daily = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: dailyTitle,
        start: "2026-03-10T09:00:00.000Z",
        end: "2026-03-10T09:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "DAILY",
          interval: 2,
          count: 3,
          exDates: ["2026-03-12T09:00:00.000Z"],
        },
      });
      assert.equal(daily.status, 201);
      assert.equal(daily.body.data.recurrence.freq, "DAILY");
      assert.equal(daily.body.data.recurrence.interval, 2);
      assert.deepEqual(daily.body.data.recurrence.exDates, ["2026-03-12T09:00:00.000Z"]);

      const weeklyTitle = buildEventTitle(config, "recur-weekly-berlin-dst");
      const weekly = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: weeklyTitle,
        start: "2026-03-23T08:00:00.000Z",
        end: "2026-03-23T08:30:00.000Z",
        timezone: "Europe/Berlin",
        recurrence: {
          freq: "WEEKLY",
          count: 3,
          byDay: ["MO"],
          weekStart: "MO",
        },
      });
      assert.equal(weekly.status, 201);
      assert.equal(weekly.body.data.recurrence.freq, "WEEKLY");
      assert.deepEqual(weekly.body.data.recurrence.byDay, ["MO"]);
      assert.equal(weekly.body.data.recurrence.weekStart, "MO");

      const monthlyTitle = buildEventTitle(config, "recur-monthly-bymonthday");
      const monthly = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: monthlyTitle,
        start: "2026-03-31T10:00:00.000Z",
        end: "2026-03-31T10:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "MONTHLY",
          count: 2,
          byMonthDay: [31],
        },
      });
      assert.equal(monthly.status, 201);
      assert.equal(monthly.body.data.recurrence.freq, "MONTHLY");
      assert.deepEqual(monthly.body.data.recurrence.byMonthDay, [31]);

      const yearlyTitle = buildEventTitle(config, "recur-yearly-until");
      const yearly = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title: yearlyTitle,
        start: "2026-03-15T12:00:00.000Z",
        end: "2026-03-15T12:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "YEARLY",
          until: "2027-03-16T00:00:00.000Z",
        },
      });
      assert.equal(yearly.status, 201);
      assert.equal(yearly.body.data.recurrence.freq, "YEARLY");
      assert.equal(yearly.body.data.recurrence.until, "2027-03-16T00:00:00.000Z");

      const marchToMay = await apiRequest(
        config,
        "GET",
        buildCollectionRoute(config, {
          start: "2026-03-01T00:00:00.000Z",
          end: "2026-05-01T00:00:00.000Z",
          limit: 100,
        })
      );
      assert.equal(marchToMay.status, 200);
      assert.deepEqual(occurrenceStarts(marchToMay.body.data.events, dailyTitle), [
        "2026-03-10T09:00:00.000Z",
        "2026-03-14T09:00:00.000Z",
        "2026-03-16T09:00:00.000Z",
      ]);
      assert.deepEqual(occurrenceStarts(marchToMay.body.data.events, weeklyTitle), [
        "2026-03-23T08:00:00.000Z",
        "2026-03-30T07:00:00.000Z",
        "2026-04-06T07:00:00.000Z",
      ]);
      assert.deepEqual(occurrenceStarts(marchToMay.body.data.events, monthlyTitle), [
        "2026-03-31T10:00:00.000Z",
        "2026-04-30T10:00:00.000Z",
      ]);
      assert.deepEqual(occurrenceStarts(marchToMay.body.data.events, yearlyTitle), ["2026-03-15T12:00:00.000Z"]);
    });

    await t.test("scope=following delete reports current Proton upstream limitation", async () => {
      const title = buildEventTitle(config, "following-delete");
      const recurring = await apiRequest(config, "POST", buildCollectionRoute(config), {
        title,
        start: "2026-03-25T12:00:00.000Z",
        end: "2026-03-25T12:30:00.000Z",
        timezone: "UTC",
        recurrence: {
          freq: "DAILY",
          count: 4,
        },
      });
      assert.equal(recurring.status, 201);

      const deleteFollowing = await apiRequest(
        config,
        "DELETE",
        buildEventRoute(config, recurring.body.data.id, {
          scope: "following",
          occurrenceStart: "2026-03-27T12:00:00.000Z",
        })
      );
      assert.equal(deleteFollowing.status, 400);
      assert.equal(deleteFollowing.body.error.code, "UPSTREAM_ERROR");
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

function occurrenceStarts(events, title) {
  return events
    .filter((event) => event.title === title)
    .map((event) => event.occurrenceStart || event.start)
    .sort();
}

async function collectPagedLiveTitles(config, prefix, range) {
  const titles = [];
  let cursor = null;
  let sawCursor = false;

  for (let page = 0; page < 200; page += 1) {
    const response = await apiRequest(config, "GET", buildCollectionRoute(config, { ...range, cursor, limit: 1 }));
    assert.equal(response.status, 200);
    titles.push(...liveTitles(response.body.data.events, prefix));
    cursor = response.body.data.nextCursor || null;
    sawCursor = sawCursor || Boolean(cursor);
    if (!cursor || titles.length >= 2) {
      break;
    }
  }

  return { titles: titles.sort(), sawCursor };
}

function liveTitles(events, prefix) {
  return events
    .filter((event) => String(event.title || "").startsWith(prefix))
    .map((event) => event.title)
    .sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
