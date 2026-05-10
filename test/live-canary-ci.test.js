import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseEnvFile } from "../scripts/ci/run-live-canary.mjs";

const execFileAsync = promisify(execFile);

test("parseEnvFile reads quoted live canary environment", () => {
  assert.deepEqual(parseEnvFile('API_BEARER_TOKEN="token"\nPC_API_BASE_URL="http://127.0.0.1:8787"\n# comment\n'), {
    API_BEARER_TOKEN: "token",
    PC_API_BASE_URL: "http://127.0.0.1:8787",
  });
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
