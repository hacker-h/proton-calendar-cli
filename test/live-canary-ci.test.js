import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildDriftShape,
  buildLiveDriftReport,
  classifyLiveCanaryFailure,
  compareLiveDriftSnapshots,
  parseEnvFile,
  parseLiveQuarantine,
} from "../scripts/ci/run-live-canary.mjs";

const execFileAsync = promisify(execFile);

test("parseEnvFile reads quoted live canary environment", () => {
  assert.deepEqual(parseEnvFile('API_BEARER_TOKEN="token"\nPC_API_BASE_URL="http://127.0.0.1:8787"\n# comment\n'), {
    API_BEARER_TOKEN: "token",
    PC_API_BASE_URL: "http://127.0.0.1:8787",
  });
});

test("parseLiveQuarantine requires owner reason and future expiry", () => {
  const now = new Date("2026-05-10T00:00:00.000Z");
  const parsed = parseLiveQuarantine(
    JSON.stringify({
      quarantines: [
        {
          id: "ui-drift-2026-05",
          suite: "bootstrap",
          check: "proton-login",
          failureClass: "proton_ui_drift",
          owner: "calendar-maintainers",
          reason: "Proton login selector changed",
          expiresAt: "2026-05-17T00:00:00.000Z",
          issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
        },
        {
          id: "expired",
          suite: "live-api",
          check: "pagination",
          failureClass: "project_regression_or_proton_drift",
          owner: "calendar-maintainers",
          reason: "old drift",
          expiresAt: "2026-05-09T00:00:00.000Z",
          issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
        },
        {
          id: "missing-owner",
          suite: "live-cli",
          check: "list",
          failureClass: "project_regression_or_proton_drift",
          reason: "needs owner",
          expiresAt: "2026-05-17T00:00:00.000Z",
          issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
        },
        {
          id: "unsafe",
          suite: "live-api",
          check: "pagination",
          failureClass: "project_regression_or_proton_drift",
          owner: "calendar-maintainers",
          reason: "API_BEARER_TOKEN=secret must not appear in reports",
          expiresAt: "2026-05-17T00:00:00.000Z",
          issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
        },
      ],
    }),
    now
  );

  assert.equal(parsed.active.length, 1);
  assert.equal(parsed.active[0].id, "ui-drift-2026-05");
  assert.deepEqual(parsed.invalid.map((entry) => entry.reason), [
    "expired quarantine",
    "missing required quarantine fields",
    "unsafe quarantine metadata",
  ]);
  assert.deepEqual(parsed.invalid[1].missing, ["owner"]);
  assert.equal(JSON.stringify(parsed).includes("API_BEARER_TOKEN"), false);
  assert.equal(Object.hasOwn(parsed.invalid[2], "id"), false);
});

test("classifyLiveCanaryFailure maps bootstrap exits, templates triage, and keeps failures visible", () => {
  const uiDrift = classifyLiveCanaryFailure(
    { stage: "bootstrap", exitCode: 60, command: "node scripts/ci/bootstrap-proton-session.mjs" },
    {
      env: {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "hacker-h/proton-calendar-cli",
        GITHUB_RUN_ID: "25620353944",
      },
      quarantine: {
        active: [
          {
            id: "ui-drift-2026-05",
            suite: "bootstrap",
            check: "proton-login",
            failureClass: "proton_ui_drift",
            owner: "calendar-maintainers",
            reason: "Proton login selector changed",
            expiresAt: "2026-05-17T00:00:00.000Z",
            issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
          },
          {
            id: "api-drift-2026-05",
            suite: "live-api",
            check: "pagination",
            failureClass: "proton_ui_drift",
            owner: "calendar-maintainers",
            reason: "Same failure class in a different suite must not match bootstrap",
            expiresAt: "2026-05-17T00:00:00.000Z",
            issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
          },
        ],
        invalid: [],
      },
    }
  );

  assert.equal(uiDrift.failureClass, "proton_ui_drift");
  assert.equal(uiDrift.suite, "bootstrap");
  assert.equal(uiDrift.check, "proton-login");
  assert.equal(uiDrift.quarantineEligible, true);
  assert.equal(uiDrift.quarantineMatches.length, 1);
  assert.equal(uiDrift.quarantineMatches[0].id, "ui-drift-2026-05");
  assert.equal(uiDrift.failureSuppressed, false);
  assert.deepEqual(uiDrift.triageTemplate, {
    command: "node scripts/ci/bootstrap-proton-session.mjs",
    requestId: null,
    logExcerpt: null,
    affectedEndpoint: "n/a",
    affectedFeature: "proton-login",
    lastPassingRun: null,
    runUrl: "https://github.com/hacker-h/proton-calendar-cli/actions/runs/25620353944",
    owner: "calendar-maintainers",
    expiresAt: "2026-05-17T00:00:00.000Z",
    issue: "https://github.com/hacker-h/proton-calendar-cli/issues/22",
  });

  const challenge = classifyLiveCanaryFailure({ stage: "bootstrap", exitCode: 50 });
  assert.equal(challenge.failureClass, "credential_auth_human_required");
  assert.equal(challenge.quarantineEligible, false);
  assert.deepEqual(challenge.quarantineMatches, []);

  const liveTests = classifyLiveCanaryFailure({ stage: "live-tests", exitCode: 1 });
  assert.equal(liveTests.failureClass, "project_regression_or_proton_drift");
  assert.equal(liveTests.suite, "live-tests");
  assert.equal(liveTests.check, "test:live");
  assert.equal(liveTests.triageTemplate.affectedEndpoint, null);
  assert.equal(liveTests.triageTemplate.lastPassingRun, null);
  assert.equal(liveTests.failureSuppressed, false);

  const browserInstall = classifyLiveCanaryFailure({ stage: "browser-install", exitCode: 1, command: "pnpm exec playwright install chromium --with-deps" });
  assert.equal(browserInstall.failureClass, "runner_browser");
  assert.equal(browserInstall.quarantineEligible, true);

  const drift = classifyLiveCanaryFailure({ stage: "drift-snapshot", exitCode: 1 });
  assert.equal(drift.failureClass, "proton_api_drift");
  assert.equal(drift.suite, "live-drift");
  assert.equal(drift.check, "schema-snapshot");
});

test("live drift snapshots compare sanitized response shapes", () => {
  const baseline = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        // events array is empty in baseline -> items: { type: "unknown" }
        shape: buildDriftShape({ data: { events: [], nextCursor: null } }),
      },
    ],
  };
  const current = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        // current has events + an extra field; nextCursor is missing -> breaking
        shape: buildDriftShape({ data: { events: [{ id: "evt-secret-title", title: "Private" }], count: 1 } }),
      },
    ],
  };

  const differences = compareLiveDriftSnapshots(baseline, current);
  // nextCursor missing from current -> breaking
  assert.equal(differences.some((difference) => difference.kind === "missing_field" && difference.severity === "breaking"), true);
  // data.count added in current -> additive
  assert.equal(differences.some((difference) => difference.kind === "added_field" && difference.severity === "additive"), true);
  // array item shape now available (baseline was unknown) -> additive, not breaking
  assert.equal(differences.some((difference) => difference.kind === "added_field" && difference.severity === "additive" && difference.message.includes("item shape now available")), true);
  // no breaking differences from array items when baseline was captured from empty array
  assert.equal(differences.filter((difference) => difference.severity === "breaking").every((difference) => difference.kind !== "type_changed" || !difference.message.includes("[]")), true);
  assert.equal(differences.every((difference) => typeof difference.likelyImpact === "string"), true);

  const serialized = JSON.stringify(buildLiveDriftReport({ baseline, current, env: { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "hacker-h/proton-calendar-cli", GITHUB_RUN_ID: "1" } }));
  assert.equal(serialized.includes("evt-secret-title"), false);
  assert.equal(serialized.includes("Private"), false);
  assert.equal(serialized.includes("https://github.com/hacker-h/proton-calendar-cli/actions/runs/1"), true);
});

test("live drift array item comparison: empty actual skips item validation non-breaking", () => {
  const baseline = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        shape: buildDriftShape({ data: { events: [{ id: "x", title: "y", start: "z", end: "w" }], nextCursor: null } }),
      },
    ],
  };
  const current = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        // actual events array is empty -> items: { type: "unknown" }
        shape: buildDriftShape({ data: { events: [], nextCursor: null } }),
      },
    ],
  };

  const differences = compareLiveDriftSnapshots(baseline, current);
  // empty array -> item shape comparison skipped, reported as additive
  assert.equal(differences.some((difference) => difference.kind === "empty_array" && difference.severity === "additive"), true);
  // no breaking differences from empty actual array
  assert.equal(differences.filter((difference) => difference.severity === "breaking").length, 0);
});

test("live drift array item comparison: non-empty actual compared against non-unknown baseline", () => {
  const baseline = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        shape: buildDriftShape({ data: { events: [{ id: "x", title: "y", start: "z" }], nextCursor: null } }),
      },
    ],
  };
  const current = {
    surfaces: [
      {
        id: "events.list",
        endpoint: "/v1/events",
        status: 200,
        // id and title present but start is missing -> breaking; extra field added -> additive
        shape: buildDriftShape({ data: { events: [{ id: "x", title: "y", extra: 1 }], nextCursor: null } }),
      },
    ],
  };

  const differences = compareLiveDriftSnapshots(baseline, current);
  // start field missing in item -> breaking
  assert.equal(differences.some((difference) => difference.kind === "missing_field" && difference.severity === "breaking" && difference.message.includes("start")), true);
  // extra field added -> additive
  assert.equal(differences.some((difference) => difference.kind === "added_field" && difference.severity === "additive"), true);
});

test("write-live-env creates runnable API and live-test environment", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "live-env-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  const envPath = path.join(tmpDir, "ci-live.env");

  await writeFile(
    cookieBundlePath,
    `${JSON.stringify({
      authProbe: {
        defaultCalendarId: "cal-default",
        calendarIds: ["cal-default", "cal-secondary"],
      },
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  await execFileAsync(process.execPath, ["scripts/ci/write-live-env.mjs"], {
    env: {
      ...process.env,
      COOKIE_BUNDLE_PATH: cookieBundlePath,
      CI_LIVE_ENV_PATH: envPath,
      PROTON_TEST_CALENDAR_ID: "cal-secondary",
      API_BEARER_TOKEN: "token-123",
      PC_API_BASE_URL: "http://127.0.0.1:8787",
    },
  });

  const values = parseEnvFile(await readFile(envPath, "utf8"));
  assert.equal(values.COOKIE_BUNDLE_PATH, "secrets/proton-cookies.json");
  assert.equal(values.TARGET_CALENDAR_ID, "cal-secondary");
  assert.equal(values.DEFAULT_CALENDAR_ID, "cal-secondary");
  assert.equal(values.ALLOWED_CALENDAR_IDS, "cal-secondary,cal-default");
  assert.equal(values.PROTON_TEST_CALENDAR_ID, "cal-secondary");
  assert.equal(values.API_BEARER_TOKEN, "token-123");
  assert.equal(values.PC_API_TOKEN, "token-123");
  assert.equal(values.PC_API_BASE_URL, "http://127.0.0.1:8787");
});

test("write-live-env generates a per-run token when none is configured", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "live-env-token-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  const firstEnvPath = path.join(tmpDir, "ci-live-first.env");
  const secondEnvPath = path.join(tmpDir, "ci-live-second.env");

  await writeFile(
    cookieBundlePath,
    `${JSON.stringify({
      authProbe: {
        defaultCalendarId: "cal-default",
        calendarIds: ["cal-default"],
      },
    }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const baseEnv = {
    ...process.env,
    COOKIE_BUNDLE_PATH: cookieBundlePath,
    PROTON_TEST_CALENDAR_ID: "cal-default",
  };
  delete baseEnv.API_BEARER_TOKEN;

  await execFileAsync(process.execPath, ["scripts/ci/write-live-env.mjs"], {
    env: {
      ...baseEnv,
      CI_LIVE_ENV_PATH: firstEnvPath,
    },
  });
  await execFileAsync(process.execPath, ["scripts/ci/write-live-env.mjs"], {
    env: {
      ...baseEnv,
      CI_LIVE_ENV_PATH: secondEnvPath,
    },
  });

  const first = parseEnvFile(await readFile(firstEnvPath, "utf8"));
  const second = parseEnvFile(await readFile(secondEnvPath, "utf8"));
  assert.match(first.API_BEARER_TOKEN, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(first.PC_API_TOKEN, first.API_BEARER_TOKEN);
  assert.notEqual(first.API_BEARER_TOKEN, "live-canary-token");
  assert.notEqual(first.API_BEARER_TOKEN, second.API_BEARER_TOKEN);
});
