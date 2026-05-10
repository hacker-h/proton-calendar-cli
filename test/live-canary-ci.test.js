import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { classifyLiveCanaryFailure, parseEnvFile, parseLiveQuarantine } from "../scripts/ci/run-live-canary.mjs";

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
      ],
    }),
    now
  );

  assert.equal(parsed.active.length, 1);
  assert.equal(parsed.active[0].id, "ui-drift-2026-05");
  assert.deepEqual(parsed.invalid.map((entry) => entry.reason), ["expired quarantine", "missing required quarantine fields"]);
  assert.deepEqual(parsed.invalid[1].missing, ["owner"]);
});

test("classifyLiveCanaryFailure maps bootstrap exits and keeps failures visible", () => {
  const uiDrift = classifyLiveCanaryFailure(
    { stage: "bootstrap", exitCode: 60, command: "node scripts/ci/bootstrap-proton-session.mjs" },
    {
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
        ],
        invalid: [],
      },
    }
  );

  assert.equal(uiDrift.failureClass, "proton_ui_drift");
  assert.equal(uiDrift.quarantineEligible, true);
  assert.equal(uiDrift.quarantineMatches.length, 1);
  assert.equal(uiDrift.failureSuppressed, false);

  const challenge = classifyLiveCanaryFailure({ stage: "bootstrap", exitCode: 50 });
  assert.equal(challenge.failureClass, "credential_auth_human_required");
  assert.equal(challenge.quarantineEligible, false);
  assert.deepEqual(challenge.quarantineMatches, []);

  const liveTests = classifyLiveCanaryFailure({ stage: "live-tests", exitCode: 1 });
  assert.equal(liveTests.failureClass, "project_regression_or_proton_drift");
  assert.equal(liveTests.failureSuppressed, false);
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
