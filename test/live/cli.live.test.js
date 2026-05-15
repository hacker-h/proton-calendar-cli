import test from "node:test";
import assert from "node:assert/strict";
import { runPcCli } from "../../src/cli.js";
import { buildEventTitle, cleanupEvents, readLiveConfig, waitForApi } from "./helpers/live-test-utils.js";

const config = readLiveConfig();
const RANGE_START = "2026-03-01T00:00:00.000Z";
const RANGE_END = "2026-04-01T00:00:00.000Z";

test("live cli suite", { skip: !config.enabled ? "PC_API_BASE_URL and PC_API_TOKEN are required" : false }, async () => {
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
    const doctor = await runJsonCli(["doctor", "auth", "--cookie-bundle", process.env.COOKIE_BUNDLE_PATH || "secrets/proton-cookies.json"]);
    assert.equal(doctor.exitCode, 0);
    assert.equal(["access_valid", "refresh_recovered"].includes(doctor.payload.data.status), true);

    await testTimedUtcCrud(env);
    await testTimedBerlinCrud(env);
    await testAllDayUtc(env);
    await testRecurrenceCrud(env);
    await testNotificationCrud(env);
    await testListWindows(env);
    await testListFiltersAndOutput(env);
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
}

async function testListFiltersAndOutput(env) {
  const prefix = buildEventTitle(config, "cli-list-filter");
  await createCliListFixtures(env, prefix);

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
