import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ICS_IMPORT_BYTES, MAX_ICS_IMPORT_EVENTS, MAX_ICS_LOCAL_IMPORT_EVENTS, assertLocalIcsImportEventLimit, exportEventsToIcs, parseIcsEvents } from "../src/ics.js";

test("parses simple timed, all-day, timezone, and recurrence VEVENTs", () => {
  const parsed = parseIcsEvents([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:timed-1",
    "SUMMARY:Planning\\, review",
    "DESCRIPTION:Line 1\\nLine 2",
    "LOCATION:Room\\; A",
    "DTSTART;TZID=Europe/Berlin:20260409T090000",
    "DTEND;TZID=Europe/Berlin:20260409T100000",
    "RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TH",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:day-1",
    "SUMMARY:Offsite",
    "DTSTART;VALUE=DATE:20260410",
    "DTEND;VALUE=DATE:20260411",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"));

  assert.equal(parsed.count, 2);
  assert.equal(parsed.events[0].title, "Planning, review");
  assert.equal(parsed.events[0].description, "Line 1\nLine 2");
  assert.equal(parsed.events[0].location, "Room; A");
  assert.equal(parsed.events[0].timezone, "Europe/Berlin");
  assert.equal(parsed.events[0].start, "2026-04-09T07:00:00Z");
  assert.deepEqual(parsed.events[0].recurrence, {
    freq: "WEEKLY",
    interval: 1,
    count: 2,
    until: null,
    byDay: ["TH"],
    byMonthDay: [],
    weekStart: null,
    exDates: [],
  });
  assert.equal(parsed.events[1].allDay, true);
  assert.equal(parsed.events[1].start, "2026-04-10");
  assert.equal(parsed.events[1].end, "2026-04-11");
});

test("preserves literal escaped backslash text on import", () => {
  const parsed = parseIcsEvents([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:literal-slash",
    "SUMMARY:Path C:\\\\notes\\\\ntext",
    "DTSTART:20260409T090000Z",
    "DTEND:20260409T100000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"));

  assert.equal(parsed.events[0].title, "Path C:\\notes\\ntext");
});

test("accepts standard VTIMEZONE subcomponents as metadata", () => {
  const parsed = parseIcsEvents([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "BEGIN:STANDARD",
    "DTSTART:20261025T030000",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    "DTSTART:20260329T020000",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "END:DAYLIGHT",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:berlin",
    "SUMMARY:Berlin",
    "DTSTART;TZID=Europe/Berlin:20260409T090000",
    "DTEND;TZID=Europe/Berlin:20260409T100000",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"));

  assert.equal(parsed.events[0].timezone, "Europe/Berlin");
  assert.equal(parsed.events[0].title, "Berlin");
});

test("exports normalized events without raw secret fields", () => {
  const ics = exportEventsToIcs([
    {
      id: "evt-1",
      uid: "original-event-uid@example.test",
      calendarId: "cal-1",
      title: "Private title",
      description: "Line 1\nLine 2",
      location: "Room A",
      start: "2026-04-09T09:00:00.000Z",
      end: "2026-04-09T10:00:00.000Z",
      timezone: "UTC",
      apiToken: "secret-token",
      recurrence: { freq: "DAILY", interval: 2, count: 3, until: null, byDay: [], byMonthDay: [], weekStart: null },
    },
  ]);

  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /UID:original-event-uid@example.test/);
  assert.match(ics, /SUMMARY:Private title/);
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
  assert.match(ics, /RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3/);
  assert.equal(ics.includes("secret-token"), false);
});

test("exports expanded recurring occurrences as bounded instances", () => {
  const ics = exportEventsToIcs([
    {
      id: "evt-1::2026-04-09T09:00:00.000Z",
      uid: "series@example.test",
      title: "Expanded occurrence",
      start: "2026-04-09T09:00:00.000Z",
      end: "2026-04-09T10:00:00.000Z",
      timezone: "UTC",
      occurrenceStart: "2026-04-09T09:00:00.000Z",
      seriesId: "evt-1",
      recurrence: { freq: "DAILY", interval: 1, count: 3, until: null, byDay: [], byMonthDay: [], weekStart: null },
    },
  ]);

  assert.match(ics, /SUMMARY:Expanded occurrence/);
  assert.equal(ics.includes("RRULE"), false);
});

test("rejects unsupported components and properties", () => {
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART:20260409T090000Z\nDTEND:20260409T100000Z\nBEGIN:VALARM\nEND:VALARM\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_UNSUPPORTED_COMPONENT" }
  );
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART:20260409T090000Z\nDTEND:20260409T100000Z\nATTENDEE:mailto:a@example.test\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_UNSUPPORTED_PROPERTY" }
  );
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nSTATUS:CANCELLED\nDTSTART:20260409T090000Z\nDTEND:20260409T100000Z\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_CANCELLED_EVENT" }
  );
});

test("rejects unsupported metadata passthrough fields by name", () => {
  assert.throws(
    () => parseIcsEvents([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:1",
      "SUMMARY:x",
      "DTSTART:20260409T090000Z",
      "DTEND:20260409T100000Z",
      "URL:https://meet.proton.me/example",
      "ORGANIZER:mailto:owner@example.test",
      "ATTENDEE:mailto:person@example.test",
      "ATTACH:https://example.test/file.pdf",
      "CATEGORIES:work,travel",
      "CONFERENCE;VALUE=URI:https://meet.proton.me/example",
      "X-CUSTOM-PROP:value",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\n")),
    {
      code: "ICS_UNSUPPORTED_PROPERTY",
      details: {
        eventIndex: 0,
        properties: ["ATTACH", "ATTENDEE", "CATEGORIES", "CONFERENCE", "ORGANIZER", "URL", "X-CUSTOM-PROP"],
      },
    }
  );
});

test("rejects impossible ICS dates before import", () => {
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART:20260231T090000Z\nDTEND:20260231T100000Z\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_INVALID_DATE" }
  );
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART;VALUE=DATE:20260231\nDTEND;VALUE=DATE:20260301\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_INVALID_DATE" }
  );
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART;TZID=Foo/Bar:20260409T090000\nDTEND;TZID=Foo/Bar:20260409T100000\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_INVALID_TIMEZONE" }
  );
  assert.throws(
    () => parseIcsEvents("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:x\nDTSTART;VALUE=DATE;TZID=Foo/Bar:20260409\nDTEND;VALUE=DATE;TZID=Foo/Bar:20260410\nEND:VEVENT\nEND:VCALENDAR\n"),
    { code: "ICS_INVALID_TIMEZONE" }
  );
});

test("enforces import size and event count limits offline", () => {
  assert.throws(() => parseIcsEvents("x".repeat(MAX_ICS_IMPORT_BYTES + 1)), { code: "ICS_IMPORT_TOO_LARGE" });

  const vevents = Array.from({ length: MAX_ICS_IMPORT_EVENTS + 1 }, (_, index) => [
    "BEGIN:VEVENT",
    `UID:${index}`,
    "SUMMARY:x",
    "DTSTART:20260409T090000Z",
    "DTEND:20260409T100000Z",
    "END:VEVENT",
  ].join("\n"));
  assert.throws(
    () => parseIcsEvents(["BEGIN:VCALENDAR", ...vevents, "END:VCALENDAR", ""].join("\n")),
    { code: "ICS_IMPORT_EVENT_LIMIT" }
  );

  assert.doesNotThrow(() => assertLocalIcsImportEventLimit(MAX_ICS_LOCAL_IMPORT_EVENTS));
  assert.throws(() => assertLocalIcsImportEventLimit(MAX_ICS_LOCAL_IMPORT_EVENTS + 1), { code: "ICS_IMPORT_BATCH_TOO_LARGE" });
});
