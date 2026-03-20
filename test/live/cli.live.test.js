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

    const title = buildEventTitle(config, "cli");
    const create = await runJsonCli([
      "create",
      ...(config.calendarId ? ["--calendar", config.calendarId] : []),
      `title=${title}`,
      "description=gitlab live cli",
      "location=CLI",
      "start=2026-03-21T10:00:00.000Z",
      "end=2026-03-21T10:30:00.000Z",
      "timezone=UTC",
    ], env);
    assert.equal(create.exitCode, 0);
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
    assert.equal(list.payload.data.events.some((event) => event.title === title), true);

    const get = await runJsonCli([
      "ls",
      ...(config.calendarId ? ["--calendar", config.calendarId] : []),
      "--start",
      "2026-03-21T00:00:00.000Z",
      "--end",
      "2026-03-22T00:00:00.000Z",
      "--limit",
      "1",
    ], env);
    assert.equal(get.exitCode, 0);
    assert.equal(Array.isArray(get.payload.data.events), true);

    const updatedTitle = buildEventTitle(config, "cli-updated");
    const edit = await runJsonCli([
      "edit",
      eventId,
      ...(config.calendarId ? ["--calendar", config.calendarId] : []),
      `title=${updatedTitle}`,
      "--clear",
      "description",
    ], env);
    assert.equal(edit.exitCode, 0);
    assert.equal(edit.payload.data.title, updatedTitle);

    const remove = await runJsonCli([
      "delete",
      eventId,
      ...(config.calendarId ? ["--calendar", config.calendarId] : []),
      "--scope",
      "series",
    ], env);
    assert.equal(remove.exitCode, 0);
  } finally {
    await cleanupEvents(config, RANGE_START, RANGE_END);
  }
});

async function runJsonCli(argv, env = {
  PC_API_BASE_URL: config.apiBaseUrl,
  PC_API_TOKEN: config.apiToken,
}) {
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runPcCli(argv, {
    env,
    stdout,
    stderr,
  });

  const output = exitCode === 0 ? stdout.value() : stderr.value();
  return {
    exitCode,
    payload: output ? JSON.parse(output) : null,
  };
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
