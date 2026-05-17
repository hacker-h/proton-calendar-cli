import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPcCli } from "../../src/cli.js";
import { buildEventTitle, cleanupEvents, readLiveConfig, skipUnlessCapability, waitForApi } from "./helpers/live-test-utils.js";

const config = readLiveConfig();
const RANGE_START = "2026-03-01T00:00:00.000Z";
const RANGE_END = "2026-04-01T00:00:00.000Z";

test("live cli suite", { skip: !config.enabled ? "PC_API_BASE_URL and PC_API_TOKEN are required" : false }, async (t) => {
  await waitForApi(config);
  await cleanupEvents(config, RANGE_START, RANGE_END);

  const env = {
    PC_API_BASE_URL: config.apiBaseUrl,
    PC_API_TOKEN: config.apiToken,
  };
  if (config.calendarId) {
    env.PROTON_TEST_CALENDAR_ID = config.calendarId;
  }

  try {
    await t.test("doctor auth reports live session readiness", async () => {
      const doctor = await runJsonCli(["doctor", "auth", "--cookie-bundle", process.env.COOKIE_BUNDLE_PATH || "secrets/proton-cookies.json"]);
      assert.equal(doctor.exitCode, 0);
      assert.equal(["access_valid", "refresh_recovered"].includes(doctor.payload.data.status), true);
    });

    await t.test("calendar settings read through CLI", async () => {
      const userSettings = await runJsonCli(["calendars", "--settings"], env);
      assert.equal(userSettings.exitCode, 0);
      assert.equal(Object.hasOwn(userSettings.payload, "data"), true);

      if (config.calendarId) {
        const calendarSettings = await runJsonCli(["calendars", "--calendar", config.calendarId, "--settings"], env);
        assert.equal(calendarSettings.exitCode, 0);
        assert.equal(calendarSettings.payload.data.calendarId, config.calendarId);
      }
    });

    await t.test("calendar settings mutation through CLI restores original", {
      skip: skipUnlessCapability(config, "calendarCrud", { reason: "calendar CRUD live mutations require PROTON_LIVE_ENABLE_CALENDAR_CRUD=1" }),
    }, async () => {
      assert.ok(config.calendarId, "calendar CRUD live mutations require configured calendar id");
      const originalUserSettings = await runJsonCli(["calendars", "--settings"], env);
      const originalCalendarSettings = await runJsonCli(["calendars", "--calendar", config.calendarId, "--settings"], env);
      const calendars = await runJsonCli(["calendars"], env);
      const originalMetadata = calendars.payload.data.calendars.find((calendar) => calendar.id === config.calendarId);
      assert.ok(originalMetadata);
      try {
        const settings = await runJsonCli(["calendars", "--calendar", config.calendarId, "--settings", "defaultDuration=60"], env);
        assert.equal(settings.exitCode, 0);
        const metadata = await runJsonCli([
          "calendars",
          "--calendar",
          config.calendarId,
          `name=${originalMetadata.name}`,
          `description=${originalMetadata.description || ""}`,
          `display=${originalMetadata.display ?? 1}`,
          ...(originalMetadata.color ? [`color=${originalMetadata.color}`] : []),
        ], env);
        assert.equal(metadata.exitCode, 0);
      } finally {
        await restoreCliCalendarCrud(env, {
          userSettings: originalUserSettings.payload.data,
          calendarSettings: originalCalendarSettings.payload.data,
          metadata: originalMetadata,
        });
      }
    });

    await t.test("timed UTC event supports create list edit clear and delete", () => testTimedUtcCrud(env));
    await t.test("timed Europe/Berlin event preserves timezone metadata", () => testTimedBerlinCrud(env));
    await t.test("all-day UTC event preserves date-only boundaries", () => testAllDayUtc(env));
    await t.test("recurring event supports scoped edit and delete arguments", () => testRecurrenceCrud(env));
    await t.test("recurrence fields support interval exDates byDay weekStart byMonthDay and until", () => testRecurrenceFieldMatrix(env));
    await t.test("notifications support raw friendly preserve and clear flows", () => testNotificationCrud(env));
    await t.test("ICS import and export round trip through CLI", () => testIcsImportExport(env));
    await t.test("patch file merges with assignments clear and calendar routing", () => testPatchFileAndCalendarRouting(env));
    let listFixturePrefix;
    await t.test("list shortcuts cover deterministic live windows", async () => {
      listFixturePrefix = await testListWindows(env);
    });
    await t.test("list filters cover text protection and output modes", () => testListFiltersAndOutput(env, listFixturePrefix));
  } finally {
    await cleanupEvents(config, RANGE_START, RANGE_END);
  }
});

async function testTimedUtcCrud(env) {
  const title = buildEventTitle(config, "cli-utc");
  const create = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=live cli utc description",
    "location=CLI UTC",
    "start=2026-03-21T10:00:00.000Z",
    "end=2026-03-21T10:30:00.000Z",
    "timezone=UTC",
    "protected=false",
    "notifications=null",
  ], env);
  assert.equal(create.exitCode, 0);
  assert.equal(create.payload.data.description, "live cli utc description");
  assert.equal(create.payload.data.location, "CLI UTC");
  assert.equal(create.payload.data.timezone, "UTC");
  assert.equal(create.payload.data.allDay, false);
  assert.equal(create.payload.data.protected, false);
  assert.equal(create.payload.data.notifications, null);
  const eventId = create.payload.data.id;

  const list = await runJsonCli([
    "list",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--start",
    "2026-03-21T00:00:00.000Z",
    "--end",
    "2026-03-22T00:00:00.000Z",
  ], env);
  assert.equal(list.exitCode, 0);
  assert.equal(findCliEvent(list.payload.data.events, title).protected, false);

  const updatedTitle = buildEventTitle(config, "cli-utc-updated");
  const edit = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${updatedTitle}`,
    "description=patched cli utc description",
    "location=Patched CLI UTC",
    "notifications=null",
  ], env);
  assert.equal(edit.exitCode, 0);
  assert.equal(edit.payload.data.title, updatedTitle);
  assert.equal(edit.payload.data.description, "patched cli utc description");
  assert.equal(edit.payload.data.location, "Patched CLI UTC");
  assert.equal(edit.payload.data.protected, false);

  const cleared = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--clear",
    "description",
    "--clear",
    "location",
  ], env);
  assert.equal(cleared.exitCode, 0);
  assert.equal(cleared.payload.data.description, "");
  assert.equal(cleared.payload.data.location, "");

  const remove = await runJsonCli([
    "delete",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--scope",
    "series",
  ], env);
  assert.equal(remove.exitCode, 0);
}

async function testTimedBerlinCrud(env) {
  const title = buildEventTitle(config, "cli-berlin");
  const create = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=live cli berlin timezone",
    "location=CLI Berlin",
    "start=2026-03-24T08:00:00.000Z",
    "end=2026-03-24T08:30:00.000Z",
    "timezone=Europe/Berlin",
    "notifications=null",
  ], env);
  assert.equal(create.exitCode, 0);
  assert.equal(create.payload.data.timezone, "Europe/Berlin");
  assert.equal(create.payload.data.protected, true);
  const eventId = create.payload.data.id;

  const list = await runJsonCli([
    "ls",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--start",
    "2026-03-24T00:00:00.000Z",
    "--end",
    "2026-03-25T00:00:00.000Z",
    "--title",
    title,
    "--location",
    "CLI Berlin",
  ], env);
  assert.equal(list.exitCode, 0);
  const match = findCliEvent(list.payload.data.events, title);
  assert.equal(match.timezone, "Europe/Berlin");
  assert.equal(match.allDay, false);

  const remove = await runJsonCli([
    "rm",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--scope",
    "series",
  ], env);
  assert.equal(remove.exitCode, 0);
}

async function testAllDayUtc(env) {
  const title = buildEventTitle(config, "cli-all-day-utc");
  const create = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=live cli all-day",
    "location=CLI All Day",
    "start=2026-03-23",
    "end=2026-03-24",
    "timezone=UTC",
    "allDay=true",
    "notifications=null",
  ], env);
  assert.equal(create.exitCode, 0);
  assert.equal(create.payload.data.allDay, true);
  assert.equal(create.payload.data.start, "2026-03-23T00:00:00.000Z");
  assert.equal(create.payload.data.end, "2026-03-24T00:00:00.000Z");

  const list = await runJsonCli([
    "ls",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--start",
    "2026-03-22T00:00:00.000Z",
    "--end",
    "2026-03-25T00:00:00.000Z",
    "--title",
    title,
  ], env);
  assert.equal(list.exitCode, 0);
  const match = findCliEvent(list.payload.data.events, title);
  assert.equal(match.allDay, true);
  assert.equal(match.start, "2026-03-23T00:00:00.000Z");
  assert.equal(match.end, "2026-03-24T00:00:00.000Z");
}

async function testRecurrenceCrud(env) {
  const title = buildEventTitle(config, "cli-recur-daily");
  const create = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=live cli recurrence",
    "location=CLI Recurrence",
    "start=2026-03-26T09:00:00.000Z",
    "end=2026-03-26T09:30:00.000Z",
    "timezone=UTC",
    "recurrence.freq=DAILY",
    "recurrence.count=4",
  ], env);
  assert.equal(create.exitCode, 0);
  assert.equal(create.payload.data.recurrence.freq, "DAILY");
  assert.equal(create.payload.data.recurrence.count, 4);
  const eventId = create.payload.data.id;

  const list = await runJsonCli([
    "ls",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--start",
    "2026-03-26T00:00:00.000Z",
    "--end",
    "2026-03-31T00:00:00.000Z",
    "--title",
    title,
  ], env);
  assert.equal(list.exitCode, 0);
  assert.deepEqual(occurrenceStarts(list.payload.data.events, title), [
    "2026-03-26T09:00:00.000Z",
    "2026-03-27T09:00:00.000Z",
    "2026-03-28T09:00:00.000Z",
    "2026-03-29T09:00:00.000Z",
  ]);

  const singleTitle = buildEventTitle(config, "cli-recur-single-edit");
  const singleEdit = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--scope",
    "single",
    "--at",
    "2026-03-27T09:00:00.000Z",
    `title=${singleTitle}`,
    "location=CLI Single Recurrence",
  ], env);
  assert.equal(singleEdit.exitCode, 0);
  assert.equal(singleEdit.payload.data.title, singleTitle);
  assert.equal(singleEdit.payload.data.location, "CLI Single Recurrence");

  const deleteFollowing = await runJsonCli([
    "rm",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--scope",
    "following",
    "--at",
    "2026-03-28T09:00:00.000Z",
  ], env);
  assert.equal(deleteFollowing.exitCode, 5);
  assert.equal(deleteFollowing.payload.error.code, "UPSTREAM_ERROR");
}

async function testRecurrenceFieldMatrix(env) {
  const dailyTitle = buildEventTitle(config, "cli-recur-daily-interval-exdate");
  const daily = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${dailyTitle}`,
    "start=2026-03-10T09:00:00.000Z",
    "end=2026-03-10T09:30:00.000Z",
    "timezone=UTC",
    "recurrence.freq=DAILY",
    "recurrence.interval=2",
    "recurrence.count=3",
    "recurrence.exDates=[\"2026-03-12T09:00:00.000Z\"]",
    "notifications=null",
  ], env);
  assert.equal(daily.exitCode, 0);
  assert.equal(daily.payload.data.recurrence.interval, 2);
  assert.deepEqual(daily.payload.data.recurrence.exDates, ["2026-03-12T09:00:00.000Z"]);

  const weeklyTitle = buildEventTitle(config, "cli-recur-weekly-byday-weekstart");
  const weekly = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${weeklyTitle}`,
    "start=2026-03-23T08:00:00.000Z",
    "end=2026-03-23T08:30:00.000Z",
    "timezone=Europe/Berlin",
    "recurrence.freq=WEEKLY",
    "recurrence.count=3",
    "recurrence.byDay=[\"MO\"]",
    "recurrence.weekStart=MO",
    "notifications=null",
  ], env);
  assert.equal(weekly.exitCode, 0);
  assert.deepEqual(weekly.payload.data.recurrence.byDay, ["MO"]);
  assert.equal(weekly.payload.data.recurrence.weekStart, "MO");

  const monthlyTitle = buildEventTitle(config, "cli-recur-monthly-bymonthday");
  const monthly = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${monthlyTitle}`,
    "start=2026-03-31T10:00:00.000Z",
    "end=2026-03-31T10:30:00.000Z",
    "timezone=UTC",
    "recurrence.freq=MONTHLY",
    "recurrence.count=2",
    "recurrence.byMonthDay=[31]",
    "notifications=null",
  ], env);
  assert.equal(monthly.exitCode, 0);
  assert.deepEqual(monthly.payload.data.recurrence.byMonthDay, [31]);

  const yearlyTitle = buildEventTitle(config, "cli-recur-yearly-until");
  const yearly = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${yearlyTitle}`,
    "start=2026-03-15T12:00:00.000Z",
    "end=2026-03-15T12:30:00.000Z",
    "timezone=UTC",
    "recurrence.freq=YEARLY",
    "recurrence.until=2027-03-16T00:00:00.000Z",
    "notifications=null",
  ], env);
  assert.equal(yearly.exitCode, 0);
  assert.equal(yearly.payload.data.recurrence.until, "2027-03-16T00:00:00.000Z");

  const listed = await runJsonCli([
    "ls",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--from",
    "2026-03-01",
    "--to",
    "2026-04-30",
    "--title",
    config.titlePrefix,
  ], env);
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(occurrenceStarts(listed.payload.data.events, dailyTitle), [
    "2026-03-10T09:00:00.000Z",
    "2026-03-14T09:00:00.000Z",
    "2026-03-16T09:00:00.000Z",
  ]);
  assert.deepEqual(occurrenceStarts(listed.payload.data.events, weeklyTitle), [
    "2026-03-23T08:00:00.000Z",
    "2026-03-30T07:00:00.000Z",
    "2026-04-06T07:00:00.000Z",
  ]);
  assert.deepEqual(occurrenceStarts(listed.payload.data.events, monthlyTitle), [
    "2026-03-31T10:00:00.000Z",
    "2026-04-30T10:00:00.000Z",
  ]);
  assert.deepEqual(occurrenceStarts(listed.payload.data.events, yearlyTitle), ["2026-03-15T12:00:00.000Z"]);
}

async function testNotificationCrud(env) {
  const title = buildEventTitle(config, "cli-notifications");
  const notifications = [{ Type: 1, Trigger: "-PT10M" }];
  const encodedNotifications = JSON.stringify(notifications);
  const create = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=live cli notifications",
    "location=CLI Reminder",
    "start=2026-03-28T10:00:00.000Z",
    "end=2026-03-28T10:30:00.000Z",
    "timezone=UTC",
    `notifications=${encodedNotifications}`,
  ], env);
  assert.equal(create.exitCode, 0);
  assert.deepEqual(create.payload.data.notifications, notifications);
  const eventId = create.payload.data.id;

  const updatedTitle = buildEventTitle(config, "cli-notifications-renamed");
  const renamed = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${updatedTitle}`,
  ], env);
  assert.equal(renamed.exitCode, 0);
  assert.deepEqual(renamed.payload.data.notifications, notifications);

  const nulled = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "notifications=null",
  ], env);
  assert.equal(nulled.exitCode, 0);
  assert.equal(nulled.payload.data.notifications, null);

  const restored = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `notifications=${encodedNotifications}`,
  ], env);
  assert.equal(restored.exitCode, 0);
  assert.deepEqual(restored.payload.data.notifications, notifications);

  const singularFriendly = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "reminder=10m",
  ], env);
  assert.equal(singularFriendly.exitCode, 0);
  assert.deepEqual(singularFriendly.payload.data.notifications, [{ Type: 1, Trigger: "-PT10M" }]);

  const friendly = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "reminders=5m,1h",
  ], env);
  assert.equal(friendly.exitCode, 0);
  assert.deepEqual(friendly.payload.data.notifications, [
    { Type: 1, Trigger: "-PT5M" },
    { Type: 1, Trigger: "-PT1H" },
  ]);

  const cleared = await runJsonCli([
    "edit",
    eventId,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--clear",
    "notifications",
  ], env);
  assert.equal(cleared.exitCode, 0);
  assert.equal(cleared.payload.data.notifications, null);
}

async function testPatchFileAndCalendarRouting(env) {
  const title = buildEventTitle(config, "cli-patch-file");
  const created = await runJsonCli([
    "new",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    `title=${title}`,
    "description=patch file original",
    "location=Patch Room A",
    "start=2026-03-22T10:00:00.000Z",
    "end=2026-03-22T10:30:00.000Z",
    "timezone=UTC",
    "protected=false",
    "notifications=null",
  ], env);
  assert.equal(created.exitCode, 0);

  const patchDir = await mkdtemp(path.join(os.tmpdir(), "pc-live-patch-"));
  const patchPath = path.join(patchDir, "patch.json");
  await writeFile(patchPath, `${JSON.stringify({
    title: buildEventTitle(config, "cli-patch-file-from-json"),
    description: "patched from json file",
    location: "Patch Room B",
  }, null, 2)}\n`);

  const updatedTitle = buildEventTitle(config, "cli-patch-file-override");
  const patched = await runJsonCli([
    "edit",
    created.payload.data.id,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--patch",
    `@${patchPath}`,
    `title=${updatedTitle}`,
    "loc=Patch Room C",
    "--clear",
    "description",
  ], env);
  assert.equal(patched.exitCode, 0);
  assert.equal(patched.payload.data.title, updatedTitle);
  assert.equal(patched.payload.data.description, "");
  assert.equal(patched.payload.data.location, "Patch Room C");

  const listed = await runJsonCli([
    "ls",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--from",
    "2026-03-22",
    "--to",
    "2026-03-22",
    "--title",
    updatedTitle,
  ], env);
  assert.equal(listed.exitCode, 0);
  const match = findCliEvent(listed.payload.data.events, updatedTitle);
  assert.equal(match.location, "Patch Room C");
  assert.equal(match.description, "");
}

async function testListWindows(env) {
  const prefix = buildEventTitle(config, "cli-list-window");
  await createCliListFixtures(env, prefix);

  await assertListWindow(env, ["ls", "today"], prefix, [`${prefix}-today`]);
  await assertListWindow(env, ["ls", "tomorrow"], prefix, [`${prefix}-tomorrow`]);
  await assertListWindow(env, ["ls", "next", "7"], prefix, [`${prefix}-today`, `${prefix}-tomorrow`, `${prefix}-next`]);
  await assertListWindow(env, ["ls", "w"], prefix, [`${prefix}-week`, `${prefix}-today`, `${prefix}-tomorrow`]);
  await assertListWindow(env, ["ls", "m", "3", "2026"], prefix, [
    `${prefix}-week`,
    `${prefix}-today`,
    `${prefix}-tomorrow`,
    `${prefix}-next`,
    `${prefix}-month`,
  ]);
  await assertYearListWindow(env, prefix, [
    `${prefix}-week`,
    `${prefix}-today`,
    `${prefix}-tomorrow`,
    `${prefix}-next`,
    `${prefix}-month`,
  ]);
  await assertListWindow(env, ["ls", "--from", "2026-03-12", "--to", "2026-03-12"], prefix, [`${prefix}-tomorrow`]);
  return prefix;
}

async function testListFiltersAndOutput(env, prefix) {
  assert.ok(prefix, "list window fixtures must be created before filter assertions");

  await assertListWindow(env, ["ls", "--from", "2026-03-01", "--to", "2026-03-31", "--title", `${prefix}-today`], prefix, [`${prefix}-today`]);
  await assertListWindow(env, ["ls", "--from", "2026-03-01", "--to", "2026-03-31", "--description", "beta workshop"], prefix, [`${prefix}-tomorrow`]);
  await assertListWindow(env, ["ls", "--from", "2026-03-01", "--to", "2026-03-31", "--location", "room c"], prefix, [`${prefix}-next`]);
  await assertListWindow(env, ["ls", "--from", "2026-03-01", "--to", "2026-03-31", "--protected"], prefix, [
    `${prefix}-week`,
    `${prefix}-today`,
    `${prefix}-next`,
  ]);
  await assertListWindow(env, ["ls", "--from", "2026-03-01", "--to", "2026-03-31", "--unprotected"], prefix, [
    `${prefix}-tomorrow`,
    `${prefix}-month`,
  ]);

  const json = await runJsonCli(["ls", "--from", "2026-03-11", "--to", "2026-03-11", "--title", prefix, "-o", "json"], env, { now: FIXED_NOW });
  assert.equal(json.exitCode, 0);
  assert.deepEqual(liveCliTitles(json.payload.data.events, prefix), [`${prefix}-today`]);

  const table = await runRawCli(["ls", "--from", "2026-03-11", "--to", "2026-03-11", "--title", prefix, "-o", "table"], env, { now: FIXED_NOW });
  assert.equal(table.exitCode, 0);
  assert.match(table.stdout, /^id\tstart\tend\ttitle\tlocation\tprotected/m);
  assert.match(table.stdout, new RegExp(`${escapeRegExp(prefix)}-today`));
  assert.equal(table.stderr, "");
}

async function testIcsImportExport(env) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-live-ics-"));
  const title = buildEventTitle(config, "ics-cli-import");
  const filePath = path.join(tmpDir, "import.ics");
  await writeFile(filePath, [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:live-cli-import@example.test",
    `SUMMARY:${title}`,
    "DESCRIPTION:live cli ics import",
    "LOCATION:ICS CLI",
    "DTSTART:20260309T100000Z",
    "DTEND:20260309T103000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"), "utf8");

  const imported = await runJsonCli([
    "import",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    filePath,
  ], env);
  assert.equal(imported.exitCode, 0);
  assert.equal(imported.payload.data.imported, 1);
  assert.equal(imported.payload.data.events[0].title, title);

  const exported = await runRawCli([
    "export",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--from",
    "2026-03-09",
    "--to",
    "2026-03-09",
  ], env);
  assert.equal(exported.exitCode, 0);
  assert.match(exported.stdout, /BEGIN:VCALENDAR/);
  assert.match(exported.stdout, new RegExp(escapeRegExp(title)));
  assert.equal(exported.stdout.includes(config.apiToken), false);
  assert.equal(exported.stderr, "");
}

const FIXED_NOW = () => Date.parse("2026-03-11T15:00:00.000Z");

async function runJsonCli(argv, env = {
  PC_API_BASE_URL: config.apiBaseUrl,
  PC_API_TOKEN: config.apiToken,
}, options = {}) {
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runPcCli(argv, {
    env,
    stdout,
    stderr,
    now: options.now,
  });

  const output = exitCode === 0 ? stdout.value() : stderr.value();
  return {
    exitCode,
    payload: output ? JSON.parse(output) : null,
  };
}

async function runRawCli(argv, env, options = {}) {
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runPcCli(argv, {
    env,
    stdout,
    stderr,
    now: options.now,
  });

  return {
    exitCode,
    stdout: stdout.value(),
    stderr: stderr.value(),
  };
}

async function createCliListFixtures(env, prefix) {
  const fixtures = [
    { suffix: "week", start: "2026-03-10T09:00:00.000Z", description: "alpha planning", location: "Room A", protected: true },
    { suffix: "today", start: "2026-03-11T10:00:00.000Z", description: "alpha workshop", location: "Room A", protected: true },
    { suffix: "tomorrow", start: "2026-03-12T10:00:00.000Z", description: "beta workshop", location: "Room B", protected: false },
    { suffix: "next", start: "2026-03-17T10:00:00.000Z", description: "gamma lab", location: "Room C", protected: true },
    { suffix: "month", start: "2026-03-25T10:00:00.000Z", description: "delta lab", location: "Room D", protected: false },
  ];

  for (const fixture of fixtures) {
    const startMs = Date.parse(fixture.start);
    const created = await runJsonCli([
      "new",
      ...(config.calendarId ? ["--calendar", config.calendarId] : []),
      `title=${prefix}-${fixture.suffix}`,
      `description=${fixture.description}`,
      `location=${fixture.location}`,
      `start=${fixture.start}`,
      `end=${new Date(startMs + 30 * 60 * 1000).toISOString()}`,
      "timezone=UTC",
      `protected=${fixture.protected}`,
      "notifications=null",
    ], env, { now: FIXED_NOW });
    assert.equal(created.exitCode, 0);
  }
}

async function assertListWindow(env, argv, prefix, expectedTitles) {
  const list = await runJsonCli([
    ...argv,
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    ...(argv.includes("--title") ? [] : ["--title", prefix]),
  ], env, { now: FIXED_NOW });
  assert.equal(list.exitCode, 0);
  assert.deepEqual(liveCliTitles(list.payload.data.events, prefix), [...expectedTitles].sort());
}

async function assertYearListWindow(env, prefix, expectedTitles) {
  const year = await runJsonCli([
    "ls",
    "y",
    "2026",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--title",
    prefix,
  ], env, { now: FIXED_NOW });
  if (year.exitCode === 0) {
    assert.deepEqual(liveCliTitles(year.payload.data.events, prefix), [...expectedTitles].sort());
    return;
  }

  // Proton may reject broad year scans with private API or range limits; verify bounded month fallback instead.
  assert.ok(year.payload?.error?.code, "year list failure should include a stable CLI error code");
  const march = await runJsonCli([
    "ls",
    "m",
    "3",
    "2026",
    ...(config.calendarId ? ["--calendar", config.calendarId] : []),
    "--title",
    prefix,
  ], env, { now: FIXED_NOW });
  assert.equal(march.exitCode, 0);
  assert.deepEqual(liveCliTitles(march.payload.data.events, prefix), [...expectedTitles].sort());
}

function liveCliTitles(events, prefix) {
  return events
    .filter((event) => String(event.title || "").startsWith(prefix))
    .map((event) => event.title)
    .sort();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createWriter() {
  let buffer = "";
  return {
    write(value) {
      buffer += String(value);
    },
    value() {
      return buffer;
    },
  };
}

function findCliEvent(events, title) {
  const match = events.find((event) => event.title === title);
  assert.ok(match, `expected live event ${title} in CLI list response`);
  return match;
}

function occurrenceStarts(events, title) {
  return events
    .filter((event) => event.title === title)
    .map((event) => event.occurrenceStart || event.start)
    .sort();
}

async function restoreCliCalendarCrud(env, original) {
  if (original.userSettings?.defaultCalendarId) {
    await runJsonCli(["calendars", "--settings", `defaultCalendarId=${original.userSettings.defaultCalendarId}`], env);
  }
  if (original.calendarSettings?.defaultDuration) {
    await runJsonCli(["calendars", "--calendar", config.calendarId, "--settings", `defaultDuration=${original.calendarSettings.defaultDuration}`], env);
  }
  await runJsonCli([
    "calendars",
    "--calendar",
    config.calendarId,
    `name=${original.metadata.name}`,
    `description=${original.metadata.description || ""}`,
    `display=${original.metadata.display ?? 1}`,
    ...(original.metadata.color ? [`color=${original.metadata.color}`] : []),
  ], env);
}
