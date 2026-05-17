import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPcCli } from "../src/cli.js";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("login bootstraps cookies and writes local config/env files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-login-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  const pcConfigPath = path.join(tmpDir, "pc-cli.json");
  const serverEnvPath = path.join(tmpDir, "pc-server.env");

  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "pm-session",
            value: "valid-session",
            domain: "calendar.proton.me",
            path: "/",
            secure: false,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const bootstrapCalls = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(
    [
      "login",
      "--cookie-bundle",
      cookieBundlePath,
      "--pc-config",
      pcConfigPath,
      "--server-env",
      serverEnvPath,
      "--timeout",
      "30",
      "--poll",
      "1",
    ],
    {
      env: {},
      bootstrapRunner: async (args) => {
        bootstrapCalls.push(args);
      },
      generateToken: () => "token-123",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/core/v4/users") {
          return jsonResponse(200, {
            Code: 1000,
            User: {
              ID: "user-1",
            },
          });
        }
        if (parsed.pathname === "/api/calendar/v1") {
          return jsonResponse(200, {
            Code: 1000,
            Calendars: [{ ID: "cal-1" }],
          });
        }
        return jsonResponse(404, { Code: 404, Error: "not found" });
      },
      stdout,
      stderr,
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(bootstrapCalls.length, 1);
  assert.equal(bootstrapCalls[0].includes("--output"), true);
  assert.equal(bootstrapCalls[0].includes(cookieBundlePath), true);

  const pcConfig = JSON.parse(await readFile(pcConfigPath, "utf8"));
  assert.equal(pcConfig.apiBaseUrl, "http://127.0.0.1:8787");
  assert.equal(pcConfig.apiToken, "token-123");

  const envFile = await readFile(serverEnvPath, "utf8");
  assert.equal(envFile.includes("API_BEARER_TOKEN=\"token-123\""), true);
  assert.equal(envFile.includes("TARGET_CALENDAR_ID=\"cal-1\""), true);
  assert.equal(envFile.includes("# export PROTON_AUTO_RELOGIN=\"1\""), true);
  assert.equal(envFile.includes("# export PROTON_RELOGIN_MODE=\"headless\""), true);

  const payload = JSON.parse(stdout.value());
  assert.equal(Object.hasOwn(payload.data, "apiToken"), false);
  assert.equal(stdout.value().includes("token-123"), false);
  assert.equal(payload.data.targetCalendarId, "cal-1");
  assert.deepEqual(payload.data.nextSteps, [
    `source ${serverEnvPath}`,
    "pnpm start",
    "open another shell and run: pc ls",
  ]);
});

test("login can write default calendar config without hard target lock", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-login-default-calendar-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  const serverEnvPath = path.join(tmpDir, "pc-server.env");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify({
      cookies: [
        {
          name: "pm-session",
          value: "valid-session",
          domain: "calendar.proton.me",
          path: "/",
          secure: false,
        },
      ],
      uidCandidates: ["uid-1"],
    }, null, 2)}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stdout = createWriter();
  const exitCode = await runPcCli(
    [
      "login",
      "--cookie-bundle",
      cookieBundlePath,
      "--server-env",
      serverEnvPath,
      "--default-calendar",
      "cal-2",
    ],
    {
      env: {},
      bootstrapRunner: async () => {},
      generateToken: () => "token-123",
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname === "/api/core/v4/users") {
          return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
        }
        if (parsed.pathname === "/api/calendar/v1") {
          return jsonResponse(200, {
            Code: 1000,
            Calendars: [{ ID: "cal-1" }, { ID: "cal-2" }],
          });
        }
        return jsonResponse(404, { Code: 404, Error: "not found" });
      },
      stdout,
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  const envFile = await readFile(serverEnvPath, "utf8");
  assert.equal(envFile.includes("TARGET_CALENDAR_ID"), false);
  assert.equal(envFile.includes("ALLOWED_CALENDAR_IDS=\"cal-1,cal-2\""), true);
  assert.equal(envFile.includes("DEFAULT_CALENDAR_ID=\"cal-2\""), true);

  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.targetCalendarId, null);
  assert.equal(payload.data.defaultCalendarId, "cal-2");
  assert.deepEqual(payload.data.allowedCalendarIds, ["cal-1", "cal-2"]);
});

test("calendars command returns discovered calendars", async () => {
  const stdout = createWriter();
  const requests = [];
  const exitCode = await runPcCli(["calendars", "-o", "table"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(200, {
        data: {
          calendars: [
            { id: "cal-1", name: "Work", default: true, target: false, color: "#3366ff", permissions: 127 },
          ],
        },
      });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(new URL(requests[0].url).pathname, "/v1/calendars");
  assert.equal(requests[0].init.headers.Authorization, "Bearer token");
  assert.equal(stdout.value(), "id\tname\tdefault\ttarget\tcolor\tpermissions\ncal-1\tWork\tyes\tno\t#3366ff\t127\n");
});

test("calendars command can update default calendar without login", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-calendar-default-test-"));
  const serverEnvPath = path.join(tmpDir, "pc-server.env");
  await writeFile(
    serverEnvPath,
    [
      'export API_BEARER_TOKEN="token"',
      'export ALLOWED_CALENDAR_IDS="cal-1,cal-2"',
      'export DEFAULT_CALENDAR_ID="cal-1"',
      'export COOKIE_BUNDLE_PATH="secrets/proton-cookies.json"',
      'export PROTON_BASE_URL="https://calendar.proton.me"',
      'export PC_API_BASE_URL="http://127.0.0.1:8787"',
      'export PC_API_TOKEN="token"',
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  const stdout = createWriter();
  const exitCode = await runPcCli(["calendars", "--set-default", "cal-2", "--server-env", serverEnvPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => jsonResponse(200, {
      data: {
        targetCalendarId: null,
        defaultCalendarId: "cal-1",
        calendars: [
          { id: "cal-1", name: "Work", default: true, target: false },
          { id: "cal-2", name: "Team", default: false, target: false },
        ],
      },
    }),
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const envFile = await readFile(serverEnvPath, "utf8");
  assert.equal(envFile.includes("TARGET_CALENDAR_ID"), false);
  assert.equal(envFile.includes('ALLOWED_CALENDAR_IDS="cal-1,cal-2"'), true);
  assert.equal(envFile.includes('DEFAULT_CALENDAR_ID="cal-2"'), true);
  assert.equal(JSON.parse(stdout.value()).data.defaultCalendarId, "cal-2");
});


test("calendars command rejects read-only calendars as default", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-read-only-default-test-"));
  const serverEnvPath = path.join(tmpDir, "pc-server.env");
  await writeFile(serverEnvPath, 'export DEFAULT_CALENDAR_ID="cal-1"\n', { mode: 0o600 });

  const stderr = createWriter();
  const exitCode = await runPcCli(["calendars", "--set-default", "cal-2", "--server-env", serverEnvPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => jsonResponse(200, {
      data: {
        targetCalendarId: null,
        defaultCalendarId: "cal-1",
        calendars: [
          { id: "cal-1", name: "Work", default: true, target: false },
          { id: "cal-2", name: "Team feed", default: false, target: false, readOnly: true },
        ],
      },
    }),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
  assert.equal((await readFile(serverEnvPath, "utf8")).includes('DEFAULT_CALENDAR_ID="cal-2"'), false);
});

test("calendars command refuses default changes while target locked", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-calendar-target-lock-test-"));
  const serverEnvPath = path.join(tmpDir, "pc-server.env");
  await writeFile(serverEnvPath, 'export TARGET_CALENDAR_ID="cal-1"\n', { mode: 0o600 });

  const stderr = createWriter();
  const exitCode = await runPcCli(["calendars", "--set-default", "cal-2", "--server-env", serverEnvPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => jsonResponse(200, {
      data: {
        targetCalendarId: "cal-1",
        calendars: [
          { id: "cal-1", name: "Work", default: false, target: true },
          { id: "cal-2", name: "Team", default: false, target: false },
        ],
      },
    }),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("calendars command reads and patches calendar settings routes", async () => {
  const requests = [];
  const stdout = createWriter();
  const exitCode = await runPcCli(["calendars", "--calendar", "cal-1", "--settings", "defaultDuration=90"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          calendarId: "cal-1",
          defaultDuration: 90,
        },
      });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/calendars/cal-1/settings");
  assert.equal(requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].init.body), { defaultDuration: 90 });
  assert.equal(JSON.parse(stdout.value()).data.defaultDuration, 90);
});

test("calendars command reads and patches user calendar settings", async () => {
  const requests = [];
  const exitCode = await runPcCli(["calendars", "--settings", "defaultCalendarId=cal-2", "notifications=[{\"Type\":1,\"Trigger\":\"-PT10M\"}]"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { data: { defaultCalendarId: "cal-2" } });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/calendar-settings");
  assert.equal(requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    defaultCalendarId: "cal-2",
    notifications: [{ Type: 1, Trigger: "-PT10M" }],
  });
});

test("calendars command patches metadata on existing calendar route", async () => {
  const requests = [];
  const exitCode = await runPcCli(["calendars", "--calendar", "cal-1", "name=2026", "description=123", "color=#112233", "display=1"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { data: { calendarId: "cal-1", name: "Renamed" } });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/calendars/cal-1");
  assert.equal(requests[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
        name: "2026",
        description: "123",
    color: "#112233",
    display: 1,
  });
});

test("login rejects unknown default calendar", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-login-invalid-calendar-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  await writeLoginCookieBundle(cookieBundlePath);

  const stderr = createWriter();
  const exitCode = await runPcCli(["login", "--cookie-bundle", cookieBundlePath, "--default-calendar", "missing-cal"], {
    env: {},
    bootstrapRunner: async () => {},
    fetchImpl: loginFetchWithCalendars([{ ID: "cal-1" }]),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("login rejects accounts with no calendars", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-login-no-calendars-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  await writeLoginCookieBundle(cookieBundlePath);

  const stderr = createWriter();
  const exitCode = await runPcCli(["login", "--cookie-bundle", cookieBundlePath], {
    env: {},
    bootstrapRunner: async () => {},
    fetchImpl: loginFetchWithCalendars([]),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 3);
  assert.equal(JSON.parse(stderr.value()).error.code, "LOGIN_FAILED");
});

test("login surfaces Proton rate limits with Retry-After details", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-login-rate-limit-test-"));
  const cookieBundlePath = path.join(tmpDir, "proton-cookies.json");
  await writeLoginCookieBundle(cookieBundlePath);

  const stderr = createWriter();
  const exitCode = await runPcCli(["login", "--cookie-bundle", cookieBundlePath], {
    env: {},
    bootstrapRunner: async () => {},
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(429, { Code: 12087, Error: "rate limited" }, [["Retry-After", "3"]]);
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 5);
  assert.deepEqual(JSON.parse(stderr.value()), {
    error: {
      code: "RATE_LIMITED",
      message: "Proton rate limit exceeded",
      details: {
        status: 429,
        retryable: true,
        retryAfterMs: 3000,
        retryAfterSeconds: 3,
      },
    },
  });
});

test("authorize alias works for login", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-authorize-test-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "pm-session",
            value: "valid-session",
            domain: "calendar.proton.me",
            path: "/",
            secure: false,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const exitCode = await runPcCli(["authorize", "--cookie-bundle", cookieBundlePath], {
    env: {
      PC_CONFIG_PATH: path.join(tmpDir, "pc-cli.json"),
      PC_SERVER_ENV_PATH: path.join(tmpDir, "pc-server.env"),
    },
    bootstrapRunner: async () => {},
    generateToken: () => "token-abc",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/core/v4/users") {
        return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
      }
      return jsonResponse(200, { Code: 1000, Calendars: [{ ID: "cal-1" }] });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
});

test("doctor auth reports access valid when calendar probe succeeds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-valid-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "auth-value",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
          {
            name: "REFRESH-uid-1",
            value: "%7B%22RefreshToken%22%3A%22r1%22%2C%22UID%22%3A%22uid-1%22%7D",
            domain: "calendar.proton.me",
            path: "/api/auth/refresh",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stdout = createWriter();
  const exitCode = await runPcCli(["doctor", "auth", "--cookie-bundle", cookieBundlePath], {
    env: {},
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/calendar/v1") {
        return jsonResponse(200, {
          Code: 1000,
          Calendars: [{ ID: "cal-1" }],
        });
      }
      return jsonResponse(404, { Code: 404, Error: "not found" });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.status, "access_valid");
  assert.equal(payload.data.automationReady, true);
  assert.equal(payload.data.reloginRequired, false);
  assert.equal(payload.data.nextStep.code, "proceed");
});

test("doctor auth detects refresh recovery path", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-refresh-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "stale",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
          {
            name: "REFRESH-uid-1",
            value: "%7B%22ResponseType%22%3A%22token%22%2C%22GrantType%22%3A%22refresh_token%22%2C%22RefreshToken%22%3A%22r1%22%2C%22UID%22%3A%22uid-1%22%7D",
            domain: "calendar.proton.me",
            path: "/api/auth/refresh",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stdout = createWriter();
  const exitCode = await runPcCli(["doctor", "auth", "--cookie-bundle", cookieBundlePath], {
    env: {},
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/calendar/v1") {
        const cookieHeader = String(init?.headers?.Cookie || "");
        if (cookieHeader.includes("AUTH-uid-1=fresh")) {
          return jsonResponse(200, {
            Code: 1000,
            Calendars: [{ ID: "cal-1" }],
          });
        }
        return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
      }

      if (parsed.pathname === "/api/auth/refresh" || parsed.pathname === "/api/auth/v4/refresh") {
        return jsonResponse(
          200,
          { Code: 1000 },
          [["set-cookie", "AUTH-uid-1=fresh; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly; SameSite=None"]]
        );
      }

      return jsonResponse(404, { Code: 404, Error: "not found" });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.automationReady, true);
  assert.equal(payload.data.nextStep.code, "proceed");
  assert.equal(payload.data.status, "refresh_recovered");
  assert.equal(payload.data.reloginRequired, false);
  assert.equal(payload.data.refreshAttempted, true);
  assert.equal(payload.data.refreshSucceeded, true);
});

test("doctor auth reports refresh failed when refresh cookies cannot recover", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-refresh-failed-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "stale",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
          {
            name: "REFRESH-uid-1",
            value: "%7B%22ResponseType%22%3A%22token%22%2C%22GrantType%22%3A%22refresh_token%22%2C%22RefreshToken%22%3A%22r1%22%2C%22UID%22%3A%22uid-1%22%7D",
            domain: "calendar.proton.me",
            path: "/api/auth/refresh",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stdout = createWriter();
  const exitCode = await runPcCli(["doctor", "auth", "--cookie-bundle", cookieBundlePath], {
    env: {},
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/api/auth/refresh" || parsed.pathname === "/api/auth/v4/refresh") {
        return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
      }
      return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.status, "refresh_failed");
  assert.equal(payload.data.automationReady, false);
  assert.equal(payload.data.reloginRequired, true);
  assert.equal(payload.data.refreshPossible, true);
  assert.equal(payload.data.refreshAttempted, true);
  assert.equal(payload.data.refreshSucceeded, false);
  assert.equal(payload.data.nextStep.code, "rerun_login_after_failed_refresh");
});

test("doctor auth reports relogin required when refresh is unavailable", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-relogin-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "stale",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stdout = createWriter();
  const exitCode = await runPcCli(["doctor", "auth", "--cookie-bundle", cookieBundlePath], {
    env: {},
    fetchImpl: async () => jsonResponse(401, { Code: 2001, Error: "Unauthorized" }),
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.status, "refresh_unavailable");
  assert.equal(payload.data.automationReady, false);
  assert.equal(payload.data.reloginRequired, true);
  assert.equal(payload.data.nextStep.code, "rerun_login_no_refresh_cookie");
});

test("doctor auth can fail CI when browser relogin is required", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-ci-fail-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "stale",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stderr = createWriter();
  const exitCode = await runPcCli([
    "doctor",
    "auth",
    "--cookie-bundle",
    cookieBundlePath,
    "--fail-on-relogin-required",
  ], {
    env: {},
    fetchImpl: async () => jsonResponse(401, { Code: 2001, Error: "Unauthorized" }),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 3);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "AUTH_RELOGIN_REQUIRED");
  assert.equal(payload.error.details.status, "refresh_unavailable");
  assert.equal(payload.error.details.automationReady, false);
  assert.equal(payload.error.details.nextStep.code, "rerun_login_no_refresh_cookie");
});

test("doctor auth can fail CI after refresh recovery fails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-doctor-ci-refresh-failed-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "AUTH-uid-1",
            value: "stale",
            domain: "calendar.proton.me",
            path: "/api/",
            secure: true,
          },
          {
            name: "REFRESH-uid-1",
            value: "%7B%22ResponseType%22%3A%22token%22%2C%22GrantType%22%3A%22refresh_token%22%2C%22RefreshToken%22%3A%22r1%22%2C%22UID%22%3A%22uid-1%22%7D",
            domain: "calendar.proton.me",
            path: "/api/auth/refresh",
            secure: true,
          },
        ],
        uidCandidates: ["uid-1"],
      },
      null,
      2
    )}\n`
  );
  await chmod(cookieBundlePath, 0o600);

  const stderr = createWriter();
  const exitCode = await runPcCli([
    "doctor",
    "auth",
    "--cookie-bundle",
    cookieBundlePath,
    "--fail-on-relogin-required",
  ], {
    env: {},
    fetchImpl: async () => jsonResponse(401, { Code: 2001, Error: "Unauthorized" }),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 3);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "AUTH_RELOGIN_REQUIRED");
  assert.equal(payload.error.details.status, "refresh_failed");
  assert.equal(payload.error.details.automationReady, false);
  assert.equal(payload.error.details.nextStep.code, "rerun_login_after_failed_refresh");
});

test("ls defaults to current week and emits json", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)));
      return jsonResponse(200, {
        data: {
          events: [{ id: "evt-1", title: "A" }],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("start"), "2026-03-09T00:00:00.000Z");
  assert.equal(requests[0].searchParams.get("end"), "2026-03-16T00:00:00.000Z");

  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
});

test("ls supports w++ and paginates", async () => {
  const requests = [];
  const stdout = createWriter();

  const exitCode = await runPcCli(["ls", "w++"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      const cursor = parsed.searchParams.get("cursor");
      if (!cursor) {
        return jsonResponse(200, {
          data: {
            events: [{ id: "evt-1" }],
            nextCursor: "1",
          },
        });
      }
      return jsonResponse(200, {
        data: {
          events: [{ id: "evt-2" }],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get("start"), "2026-03-09T00:00:00.000Z");
  assert.equal(requests[0].searchParams.get("end"), "2026-03-30T00:00:00.000Z");

  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 2);
});

test("ls explicit date range overrides shortcut", async () => {
  const requests = [];

  const exitCode = await runPcCli(["ls", "w++", "--from", "2026-07-01", "--to", "2026-07-31"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)));
      return jsonResponse(200, {
        data: {
          events: [],
          nextCursor: null,
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("start"), "2026-07-01T00:00:00.000Z");
  assert.equal(requests[0].searchParams.get("end"), "2026-08-01T00:00:00.000Z");
});

test("ls --start and --end date-only strings apply same boundary semantics as --from/--to", async () => {
  const makeRunner = (argv) => {
    const requests = [];
    const exitCode = runPcCli(argv, {
      env: { PC_API_BASE_URL: "http://127.0.0.1:8787", PC_API_TOKEN: "token" },
      now: () => Date.parse("2026-03-11T15:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(new URL(String(url)));
        return jsonResponse(200, { data: { events: [], nextCursor: null } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    });
    return exitCode.then((code) => ({ code, requests }));
  };

  const [fromTo, startEnd] = await Promise.all([
    makeRunner(["ls", "--from", "2026-07-01", "--to", "2026-07-31"]),
    makeRunner(["ls", "--start", "2026-07-01", "--end", "2026-07-31"]),
  ]);

  assert.equal(fromTo.code, 0);
  assert.equal(startEnd.code, 0);
  assert.equal(fromTo.requests[0].searchParams.get("start"), "2026-07-01T00:00:00.000Z");
  assert.equal(fromTo.requests[0].searchParams.get("end"), "2026-08-01T00:00:00.000Z");
  assert.equal(startEnd.requests[0].searchParams.get("start"), fromTo.requests[0].searchParams.get("start"));
  assert.equal(startEnd.requests[0].searchParams.get("end"), fromTo.requests[0].searchParams.get("end"));
});

test("ls supports deterministic today and tomorrow windows", async () => {
  const cases = [
    {
      argv: ["ls", "today"],
      expectedStart: "2026-03-11T00:00:00.000Z",
      expectedEnd: "2026-03-12T00:00:00.000Z",
    },
    {
      argv: ["ls", "tomorrow"],
      expectedStart: "2026-03-12T00:00:00.000Z",
      expectedEnd: "2026-03-13T00:00:00.000Z",
    },
  ];

  for (const current of cases) {
    const requests = [];
    const exitCode = await runPcCli(current.argv, {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      now: () => Date.parse("2026-03-11T15:00:00.000Z"),
      fetchImpl: async (url) => {
        requests.push(new URL(String(url)));
        return jsonResponse(200, {
          data: {
            events: [],
            nextCursor: null,
          },
        });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    });

    assert.equal(exitCode, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("start"), current.expectedStart);
    assert.equal(requests[0].searchParams.get("end"), current.expectedEnd);
  }
});

test("ls next days window composes with filters", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "next", "7", "days", "--title", "review", "--location", "room b", "--protected"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      requests.push(new URL(String(url)));
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "Design Review", location: "Room B", protected: true },
            { id: "evt-2", title: "Design Review", location: "Room A", protected: true },
            { id: "evt-3", title: "Planning", location: "Room B", protected: true },
            { id: "evt-4", title: "Design Review", location: "Room B", protected: false },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("start"), "2026-03-11T00:00:00.000Z");
  assert.equal(requests[0].searchParams.get("end"), "2026-03-18T00:00:00.000Z");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-1");
});

test("ls next rejects invalid day counts before API calls", async () => {
  const stderr = createWriter();
  const exitCode = await runPcCli(["ls", "next", "0"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "next window days must be an integer between 1 and 366");
});

test("ls --protected filters to protected events only", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--protected"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "A", protected: true },
            { id: "evt-2", title: "B", protected: false },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events.length, 1);
  assert.equal(payload.data.events[0].id, "evt-1");
  assert.equal(payload.data.events[0].protected, true);
});

test("ls --unprotected filters to unprotected events only", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--unprotected"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "A", protected: true },
            { id: "evt-2", title: "B", protected: false },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events.length, 1);
  assert.equal(payload.data.events[0].id, "evt-2");
  assert.equal(payload.data.events[0].protected, false);
});

test("ls --protected and --unprotected together throws INVALID_ARGS", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--protected", "--unprotected"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, { data: { events: [], nextCursor: null } });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
});

test("new rejects whitespace-only title before API call", async () => {
  const stderr = createWriter();

  const exitCode = await runPcCli(
    ["new", "title=   ", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z", "timezone=UTC"],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        throw new Error("should not call API");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "title cannot be blank");
});

test("edit rejects whitespace-only title before API call", async () => {
  const stderr = createWriter();

  const exitCode = await runPcCli(["edit", "evt-1", "title=   "], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      throw new Error("should not call API");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "title cannot be blank");
});

test("new rejects reversed time range before API call", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    [
      "new",
      "title=Invalid range",
      "start=2026-07-02T10:30:00Z",
      "end=2026-07-02T10:00:00Z",
      "timezone=UTC",
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "end must be after start");
});

test("edit rejects reversed time range before API call", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    ["edit", "evt-1", "start=2026-07-02T10:30:00Z", "end=2026-07-02T10:00:00Z"],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "end must be after start");
});

test("new trims string assignment values before sending request", async () => {
  const requests = [];

  const exitCode = await runPcCli(
    [
      "new",
      "title=  Design review  ",
      "description=  Prep notes  ",
      "location=  {not-json}  ",
      "start=2026-03-10T10:00:00Z",
      "end=2026-03-10T10:30:00Z",
      "timezone=  UTC  ",
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(200, { data: { id: "evt-1" } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.title, "Design review");
  assert.equal(body.description, "Prep notes");
  assert.equal(body.location, "{not-json}");
  assert.equal(body.timezone, "UTC");
});

test("new trims option values validated with requireValue", async () => {
  const requests = [];

  const exitCode = await runPcCli(
    ["new", "title=Design review", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z", "--tz", "  UTC  "],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(200, { data: { id: "evt-1" } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.timezone, "UTC");
});

test("new sends normal string assignment values unchanged", async () => {
  const requests = [];

  const exitCode = await runPcCli(
    ["new", "title=Design review", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z", "timezone=UTC"],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(200, { data: { id: "evt-1" } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init.body));
  assert.equal(body.title, "Design review");
});

test("new compiles friendly reminder assignment to notifications", async () => {
  const requests = [];

  const exitCode = await runPcCli(
    ["new", "title=Reminder", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z", "timezone=UTC", "reminder=10m"],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(200, { data: { id: "evt-1" } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  const body = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(body.notifications, [{ Type: 1, Trigger: "-PT10M" }]);
  assert.equal(Object.hasOwn(body, "reminder"), false);
});

test("edit compiles multiple friendly reminders to notifications", async () => {
  const requests = [];

  const exitCode = await runPcCli(["edit", "evt-1", "reminders=10m,1h"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { data: { id: "evt-1" } });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(body, {
    notifications: [
      { Type: 1, Trigger: "-PT10M" },
      { Type: 1, Trigger: "-PT1H" },
    ],
  });
});

test("friendly reminders reject invalid syntax before API calls", async () => {
  for (const assignment of ["reminder=0m", "reminders=email:1h", "reminders=sms:10m", "reminders=10m,"]) {
    const stderr = createWriter();
    let apiCalled = false;

    const exitCode = await runPcCli(
      ["new", "title=Bad", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z", assignment],
      {
        env: {
          PC_API_BASE_URL: "http://127.0.0.1:8787",
          PC_API_TOKEN: "token",
        },
        fetchImpl: async () => {
          apiCalled = true;
          throw new Error("should not call API");
        },
        stdout: createWriter(),
        stderr,
      }
    );

    assert.equal(exitCode, 2);
    assert.equal(apiCalled, false);
    assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_REMINDERS");
  }
});

test("friendly reminders cannot be mixed with raw notifications", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    [
      "new",
      "title=Bad",
      "start=2026-03-10T10:00:00Z",
      "end=2026-03-10T10:30:00Z",
      "reminder=10m",
      'notifications=[{"Type":1,"Trigger":"-PT5M"}]',
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_REMINDERS");
});

test("new dry-run previews request without config or API call", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    ["new", "--dry-run", "title=Design review", "start=2026-03-10T10:00:00Z", "end=2026-03-10T10:30:00Z"],
    {
      env: {},
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout,
      stderr,
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(apiCalled, false);
  assert.deepEqual(JSON.parse(stdout.value()), {
    data: {
      dryRun: true,
      operation: "create",
      method: "POST",
      path: "/v1/events",
      query: {},
      payload: {
        title: "Design review",
        start: "2026-03-10T10:00:00Z",
        end: "2026-03-10T10:30:00Z",
        timezone: "UTC",
      },
    },
  });
});

test("ls rejects whitespace-only text filter before API call", async () => {
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--title", "   "], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      throw new Error("should not call API");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "--title requires a value");
});

test("ls -o table includes protected column", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "-o", "table"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [{ id: "evt-1", title: "A", start: "2026-03-11T10:00:00.000Z", end: "2026-03-11T11:00:00.000Z", location: "", protected: true }],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const output = stdout.value();
  assert.ok(output.includes("protected"), "header should include 'protected'");
  assert.ok(output.includes("yes"), "row should include 'yes' for protected event");
});

test("ls --title filters by case-insensitive title substring", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--title", "review"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "Design Review" },
            { id: "evt-2", title: "Sprint Planning" },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-1");
});

test("ls --description filters by case-insensitive description substring", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--description", "workshop"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "A", description: "Internal workshop prep" },
            { id: "evt-2", title: "B", description: "Team sync" },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-1");
});

test("ls --location filters by case-insensitive location substring", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--location", "room a"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "A", location: "Room A - North" },
            { id: "evt-2", title: "B", location: "Room B" },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-1");
});

test("ls combines text filters with AND semantics", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--title", "review", "--location", "room b"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async () => {
      return jsonResponse(200, {
        data: {
          events: [
            { id: "evt-1", title: "Design Review", location: "Room A" },
            { id: "evt-2", title: "Design Review", location: "Room B" },
            { id: "evt-3", title: "Planning", location: "Room B" },
          ],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-2");
});

test("ls applies filters before limit across paginated results", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--title", "review", "--limit", "1"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      const cursor = parsed.searchParams.get("cursor");
      if (!cursor) {
        return jsonResponse(200, {
          data: {
            events: [{ id: "evt-1", title: "Planning" }],
            nextCursor: "1",
          },
        });
      }

      return jsonResponse(200, {
        data: {
          events: [{ id: "evt-2", title: "Design Review" }],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(requests.length, 2);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-2");
});

test("ls applies combined protected and text filters before limit across paginated results", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--title", "review", "--protected", "--limit", "1"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      const cursor = parsed.searchParams.get("cursor");
      if (!cursor) {
        return jsonResponse(200, {
          data: {
            events: [
              { id: "evt-1", title: "Planning", protected: true },
              { id: "evt-2", title: "Design Review", protected: false },
            ],
            nextCursor: "1",
          },
        });
      }

      return jsonResponse(200, {
        data: {
          events: [{ id: "evt-3", title: "Design Review", protected: true }],
          nextCursor: null,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(requests.length, 2);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.count, 1);
  assert.equal(payload.data.events[0].id, "evt-3");
});

test("ls fails when API pagination cap would truncate results", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["ls", "--from", "2026-03-01", "--to", "2026-04-01"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    now: () => Date.parse("2026-03-11T15:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      requests.push(parsed);
      return jsonResponse(200, {
        data: {
          events: [],
          nextCursor: `cursor-${requests.length}`,
        },
      });
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 5);
  assert.equal(stdout.value(), "");
  assert.equal(requests.length, 100);
  assert.equal(requests[99].searchParams.get("cursor"), "cursor-99");
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "EVENT_LIST_PAGE_LIMIT");
  assert.deepEqual(payload.error.details, {
    range: {
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-04-02T00:00:00.000Z",
    },
    pageLimit: 100,
    pageSize: 200,
    nextCursor: "cursor-100",
  });
});

test("edit sends differential patch and clear fields", async () => {
  const requests = [];
  const stdout = createWriter();

  const exitCode = await runPcCli(
    [
      "edit",
      "evt-1",
      'title=Renamed',
      '--clear',
      'description',
      '--scope',
      'single',
      '--at',
      '2026-03-12T09:00:00.000Z',
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(200, {
          data: {
            id: "evt-1",
            title: "Renamed",
          },
        });
      },
      stdout,
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/v1/events/evt-1");
  assert.equal(requests[0].url.searchParams.get("scope"), "single");
  assert.equal(requests[0].url.searchParams.get("occurrenceStart"), "2026-03-12T09:00:00.000Z");

  const body = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(body, {
    title: "Renamed",
    description: "",
  });

  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.title, "Renamed");
});

test("edit fails when no patch fields are provided", async () => {
  const stderr = createWriter();

  const exitCode = await runPcCli(["edit", "evt-1"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "EMPTY_PATCH");
});

test("edit accepts event ids that begin with a dash", async () => {
  const requests = [];

  const exitCode = await runPcCli(["edit", "-evt-live", "title=Dash id"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          id: "-evt-live",
          title: "Dash id",
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/events/-evt-live");
});

test("edit rejects option-shaped missing event ids", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(["edit", "--dry-run", "title=Dash id"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      apiCalled = true;
      throw new Error("should not call API");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("edit supports separator before option-shaped event ids", async () => {
  const requests = [];

  const exitCode = await runPcCli(["edit", "--", "--evt-live", "title=Dash id"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          id: "--evt-live",
          title: "Dash id",
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/events/--evt-live");
});

test("rm sends delete with scope", async () => {
  const requests = [];

  const exitCode = await runPcCli(["rm", "evt-1", "--scope", "series"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          deleted: true,
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].url.searchParams.get("scope"), "series");
});

test("rm accepts event ids that begin with a dash", async () => {
  const requests = [];

  const exitCode = await runPcCli(["rm", "-evt-live", "--scope", "series"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          deleted: true,
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/events/-evt-live");
  assert.equal(requests[0].init.method, "DELETE");
});

test("rm rejects option-shaped missing event ids", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(["rm", "--scope", "series"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      apiCalled = true;
      throw new Error("should not call API");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("help works with leading -- separator", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["--", "help"], {
    env: {},
    fetchImpl: async () => {
      throw new Error("should not call API");
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(stdout.value().includes("pc - Proton Calendar CLI"), true);
  assert.equal(stdout.value().includes("pc update [--check] [--version <tag>]"), true);
});

test("update --check reports current binary from matching release checksum", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-current-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  const binary = Buffer.from("current-binary");
  await writeFile(execPath, binary, { mode: 0o755 });
  const checksum = sha256ForTest(binary);
  const stdout = createWriter();

  const exitCode = await runPcCli(["update", "--check"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum }),
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.update, "current");
  assert.equal(payload.data.updateAvailable, false);
  assert.equal(payload.data.version, "v1.9.0");
});

test("update --check supports explicit release tag lookup", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-version-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  const binary = Buffer.from("current-binary");
  await writeFile(execPath, binary, { mode: 0o755 });
  const requestedUrls = [];
  const stdout = createWriter();

  const exitCode = await runPcCli(["update", "--check", "--version", "1.8.0"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum: sha256ForTest(Buffer.from("new-binary")), requestedUrls }),
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requestedUrls[0].endsWith("/releases/tags/v1.8.0"), true);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.update, "available");
  assert.equal(payload.data.updateAvailable, true);
});

test("update fails safely for npm and source installs", async () => {
  const stdout = createWriter();
  const stderr = createWriter();

  const exitCode = await runPcCli(["update", "--check"], {
    env: {},
    execPath: process.execPath,
    fetchImpl: async () => {
      throw new Error("should not fetch releases");
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "UPDATE_UNSUPPORTED");
});

test("update verifies checksum before replacing binary", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-checksum-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  await writeFile(execPath, "current-binary", { mode: 0o755 });
  const stderr = createWriter();

  const exitCode = await runPcCli(["update"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum: sha256ForTest(Buffer.from("expected-binary")), binary: Buffer.from("tampered-binary") }),
    smokeBinary: async () => {
      throw new Error("should not smoke before checksum passes");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(await readFile(execPath, "utf8"), "current-binary");
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "UPDATE_CHECKSUM_MISMATCH");
});

test("update no-ops when current binary already matches without --check", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-noop-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  const binary = Buffer.from("current-binary");
  await writeFile(execPath, binary, { mode: 0o755 });
  const requestedUrls = [];
  const stdout = createWriter();

  const exitCode = await runPcCli(["update"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum: sha256ForTest(binary), requestedUrls }),
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(await readFile(execPath, "utf8"), "current-binary");
  assert.equal(requestedUrls.includes("https://downloads.example/pc-linux-x64"), false);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.update, "current");
  assert.equal(payload.data.updateAvailable, false);
});

test("update removes temp binary when smoke check fails", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-smoke-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  const binary = Buffer.from("replacement-binary");
  await writeFile(execPath, "current-binary", { mode: 0o755 });
  const stderr = createWriter();

  const exitCode = await runPcCli(["update"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum: sha256ForTest(binary), binary }),
    smokeBinary: async () => {
      throw new Error("bad binary");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.equal(await readFile(execPath, "utf8"), "current-binary");
  assert.deepEqual(await readdir(tmpDir), ["pc-linux-x64"]);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "UPDATE_FAILED");
});

test("update refuses Windows helper paths with cmd metacharacters", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-win&test-"));
  const execPath = path.join(tmpDir, "pc.exe");
  const binary = Buffer.from("replacement-binary");
  await writeFile(execPath, "current-binary", { mode: 0o755 });
  const stderr = createWriter();

  const exitCode = await runPcCli(["update"], {
    env: {},
    execPath,
    platform: "win32",
    arch: "x64",
    fetchImpl: releaseFetch({ assetName: "pc-windows-x64.exe", checksum: sha256ForTest(binary), binary }),
    smokeBinary: async () => {},
    spawnImpl: () => {
      throw new Error("should not spawn unsafe cmd helper");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(await readFile(execPath, "utf8"), "current-binary");
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "UPDATE_UNSUPPORTED");
});

test("update installs verified binary on POSIX platforms", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-update-install-test-"));
  const execPath = path.join(tmpDir, "pc-linux-x64");
  const binary = Buffer.from("replacement-binary");
  await writeFile(execPath, "current-binary", { mode: 0o755 });
  const stdout = createWriter();
  const smoked = [];

  const exitCode = await runPcCli(["update"], {
    env: {},
    execPath,
    platform: "linux",
    arch: "x64",
    fetchImpl: releaseFetch({ checksum: sha256ForTest(binary), binary }),
    smokeBinary: async (file) => {
      smoked.push(file);
      assert.equal(await readFile(file, "utf8"), "replacement-binary");
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(await readFile(execPath, "utf8"), "replacement-binary");
  assert.equal(smoked.length, 1);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.update, "installed");
});

test("edit supports --patch @file and assignment overrides", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-test-"));
  const patchPath = path.join(tmpDir, "patch.json");
  await writeFile(
    patchPath,
    `${JSON.stringify({ title: "From file", description: "Old", location: "A" }, null, 2)}\n`
  );

  const requests = [];
  const exitCode = await runPcCli(["edit", "evt-1", "--patch", `@${patchPath}`, "loc=Room B", "--clear", "description"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          id: "evt-1",
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);

  const body = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(body, {
    title: "From file",
    description: "",
    location: "Room B",
  });
});

test("edit dry-run previews differential patch without config or API call", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    [
      "edit",
      "evt-1",
      "--dry-run",
      "--calendar",
      "cal-1",
      "title=Renamed",
      "--clear",
      "description",
      "--scope",
      "single",
      "--at",
      "2026-03-12T09:00:00.000Z",
    ],
    {
      env: {},
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout,
      stderr,
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(apiCalled, false);
  assert.deepEqual(JSON.parse(stdout.value()), {
    data: {
      dryRun: true,
      operation: "update",
      method: "PATCH",
      path: "/v1/calendars/cal-1/events/evt-1",
      query: {
        scope: "single",
        occurrenceStart: "2026-03-12T09:00:00.000Z",
      },
      payload: {
        title: "Renamed",
        description: "",
      },
    },
  });
});

test("dry-run still rejects invalid mutation args before config or API", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    ["new", "--dry-run", "title=Bad", "start=2026-07-02T10:30:00Z", "end=2026-07-02T10:00:00Z"],
    {
      env: {},
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not call API");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_ARGS");
  assert.equal(payload.error.message, "end must be after start");
});

test("new rejects invalid --tz before API call", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    [
      "new",
      "title=Bad timezone",
      "start=2026-04-09T09:00:00.000Z",
      "end=2026-04-09T10:00:00.000Z",
      "--tz",
      "Europe/Berln",
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not be called");
      },
      stdout,
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(stdout.value(), "");
  assert.equal(apiCalled, false);

  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "INVALID_TIMEZONE");
  assert.match(payload.error.message, /Europe\/Berln/);
});

test("new accepts UTC and IANA timezone inputs", async () => {
  for (const timezone of ["UTC", "America/New_York"]) {
    const requests = [];
    const stdout = createWriter();
    const stderr = createWriter();

    const exitCode = await runPcCli(
      [
        "new",
        `title=${timezone} event`,
        "start=2026-04-09T09:00:00.000Z",
        "end=2026-04-09T10:00:00.000Z",
        "--tz",
        timezone,
      ],
      {
        env: {
          PC_API_BASE_URL: "http://127.0.0.1:8787",
          PC_API_TOKEN: "token",
        },
        fetchImpl: async (url, init) => {
          requests.push({ url: new URL(String(url)), init });
          return jsonResponse(201, { data: { id: `evt-${timezone}`, timezone } });
        },
        stdout,
        stderr,
      }
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.value(), "");
    assert.equal(requests.length, 1);

    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.timezone, timezone);

    const payload = JSON.parse(stdout.value());
    assert.equal(payload.data.timezone, timezone);
  }
});

test("new rejects GMT edge case as non-IANA input", async () => {
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(
    [
      "new",
      "title=GMT edge",
      "start=2026-04-09T09:00:00.000Z",
      "end=2026-04-09T10:00:00.000Z",
      "--tz",
      "GMT",
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not be called");
      },
      stdout: createWriter(),
      stderr,
    }
  );

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_TIMEZONE");
});

test("new without timezone preserves default UTC behavior", async () => {
  const requests = [];

  const exitCode = await runPcCli(
    [
      "new",
      "title=Default timezone",
      "start=2026-04-09T09:00:00.000Z",
      "end=2026-04-09T10:00:00.000Z",
    ],
    {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: new URL(String(url)), init });
        return jsonResponse(201, { data: { id: "evt-default" } });
      },
      stdout: createWriter(),
      stderr: createWriter(),
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(String(requests[0].init.body)).timezone, "UTC");
});

test("edit validates timezone flag, assignment, and patch file inputs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-timezone-test-"));
  const patchPath = path.join(tmpDir, "patch.json");
  await writeFile(patchPath, `${JSON.stringify({ timezone: "Eastern Standard Time" }, null, 2)}\n`);

  for (const args of [
    ["edit", "evt-1", "--tz", "Europe/Berln"],
    ["edit", "evt-1", "tz=Europe/Berln"],
    ["edit", "evt-1", "--patch", `@${patchPath}`],
  ]) {
    const stderr = createWriter();
    let apiCalled = false;

    const exitCode = await runPcCli(args, {
      env: {
        PC_API_BASE_URL: "http://127.0.0.1:8787",
        PC_API_TOKEN: "token",
      },
      fetchImpl: async () => {
        apiCalled = true;
        throw new Error("should not be called");
      },
      stdout: createWriter(),
      stderr,
    });

    assert.equal(exitCode, 2);
    assert.equal(apiCalled, false);
    assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_TIMEZONE");
  }
});

test("edit without timezone preserves floating patch behavior", async () => {
  const requests = [];

  const exitCode = await runPcCli(["edit", "evt-1", "title=Floating update"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { data: { id: "evt-1", title: "Floating update" } });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);

  const body = JSON.parse(String(requests[0].init.body));
  assert.deepEqual(body, {
    title: "Floating update",
  });
});

test("loads API token/base URL from local config file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-config-test-"));
  const configPath = path.join(tmpDir, "pc-cli.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ apiBaseUrl: "http://127.0.0.1:9900", apiToken: "file-token" }, null, 2)}\n`
  );
  await chmod(configPath, 0o600);

  const requests = [];
  const exitCode = await runPcCli(["ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"], {
    env: {
      PC_CONFIG_PATH: configPath,
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(200, {
        data: {
          events: [],
          nextCursor: null,
        },
      });
    },
    stdout: createWriter(),
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin, "http://127.0.0.1:9900");
  assert.equal(requests[0].init.headers.Authorization, "Bearer file-token");
});

test("export command requires explicit range and writes text/calendar", async () => {
  const requests = [];
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runPcCli(["export", "--from", "2026-07-01", "--to", "2026-07-31", "--calendar", "cal-1"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return textResponse(200, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    },
    stdout,
    stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.value(), "");
  assert.equal(stdout.value(), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  assert.equal(requests[0].url.pathname, "/v1/calendars/cal-1/ics");
  assert.equal(requests[0].url.searchParams.get("start"), "2026-07-01T00:00:00.000Z");
  assert.equal(requests[0].url.searchParams.get("end"), "2026-08-01T00:00:00.000Z");
  assert.equal(requests[0].init.headers.Accept, "text/calendar");
});

test("export command rejects broad implicit scans", async () => {
  const stderr = createWriter();
  let apiCalled = false;
  const exitCode = await runPcCli(["export"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      apiCalled = true;
      return textResponse(200, "");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("export command rejects impossible date-only bounds", async () => {
  const stderr = createWriter();
  let apiCalled = false;
  const exitCode = await runPcCli(["export", "--from", "2026-02-31", "--to", "2026-03-02"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      apiCalled = true;
      return textResponse(200, "");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "INVALID_ARGS");
});

test("import command posts local ICS file as text/calendar", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-ics-import-test-"));
  const icsPath = path.join(tmpDir, "calendar.ics");
  await writeFile(icsPath, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");

  const requests = [];
  const stdout = createWriter();
  const exitCode = await runPcCli(["import", "--calendar", "cal-1", icsPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(String(url)), init });
      return jsonResponse(201, { data: { imported: 0, events: [] } });
    },
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  assert.equal(requests[0].url.pathname, "/v1/calendars/cal-1/ics");
  assert.equal(requests[0].init.headers["Content-Type"], "text/calendar; charset=utf-8");
  assert.match(requests[0].init.headers["X-Idempotency-Key"], /^ics-import-[a-f0-9]{32}$/);
  assert.equal(requests[0].init.body, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
  assert.deepEqual(JSON.parse(stdout.value()).data, { imported: 0, events: [] });
});

test("import command enforces 10 MB file limit before API call", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-ics-limit-test-"));
  const icsPath = path.join(tmpDir, "large.ics");
  await writeFile(icsPath, "x".repeat(10 * 1024 * 1024 + 1));
  const stderr = createWriter();
  let apiCalled = false;

  const exitCode = await runPcCli(["import", icsPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      apiCalled = true;
      return jsonResponse(201, { data: {} });
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(apiCalled, false);
  assert.equal(JSON.parse(stderr.value()).error.code, "ICS_IMPORT_TOO_LARGE");
});

test("entrypoint loads local .env without overriding shell env", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-dotenv-test-"));
  await writeFile(
    path.join(tmpDir, ".env"),
    [
      "PC_API_BASE_URL=not-a-url",
      "PC_API_TOKEN=dotenv-token",
      "",
    ].join("\n")
  );
  await chmod(path.join(tmpDir, ".env"), 0o600);

  const result = await execFileResult(
    process.execPath,
    [cliPath, "ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"],
    {
      cwd: tmpDir,
      env: minimalProcessEnv({
        PC_API_BASE_URL: "http://127.0.0.1:1",
      }),
    }
  );

  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stderr).error.code, "API_UNREACHABLE");
  assert.equal(result.stderr.includes("dotenv-token"), false);
});

test("unsafe local config permissions are rejected before API calls", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not reliable on Windows");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-config-permissions-test-"));
  const configPath = path.join(tmpDir, "pc-cli.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ apiBaseUrl: "http://127.0.0.1:9900", apiToken: "file-token" }, null, 2)}\n`
  );
  await chmod(configPath, 0o644);

  const requests = [];
  const stderr = createWriter();
  const exitCode = await runPcCli(["ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"], {
    env: { PC_CONFIG_PATH: configPath },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { data: { events: [], nextCursor: null } });
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(requests.length, 0);
  assert.equal(JSON.parse(stderr.value()).error.code, "SECRET_FILE_UNSAFE_PERMISSIONS");
});

test("logout removes configured local secret files and reports missing sidecars", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-logout-test-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");
  const pcConfigPath = path.join(tmpDir, "pc-cli.json");
  const serverEnvPath = path.join(tmpDir, "pc-server.env");
  const reloginLockPath = `${cookieBundlePath}.relogin.lock`;

  await writeFile(cookieBundlePath, "{}\n", { mode: 0o600 });
  await writeFile(pcConfigPath, "{}\n", { mode: 0o600 });
  await writeFile(serverEnvPath, "TOKEN=value\n", { mode: 0o600 });
  await writeFile(reloginLockPath, "lock\n", { mode: 0o600 });

  const stdout = createWriter();
  const exitCode = await runPcCli([
    "logout",
    "--cookie-bundle",
    cookieBundlePath,
    "--pc-config",
    pcConfigPath,
    "--server-env",
    serverEnvPath,
  ], {
    env: {},
    stdout,
    stderr: createWriter(),
  });

  assert.equal(exitCode, 0);
  const payload = JSON.parse(stdout.value());
  assert.equal(payload.data.logout, "ok");
  assert.deepEqual(
    payload.data.removed.map((item) => item.kind),
    ["cliConfig", "serverEnv", "cookieBundle", "reloginLock"]
  );
  assert.deepEqual(payload.data.missing.map((item) => item.kind), ["reloginState"]);

  for (const filePath of [cookieBundlePath, pcConfigPath, serverEnvPath, reloginLockPath]) {
    await assert.rejects(() => readFile(filePath, "utf8"), { code: "ENOENT" });
  }
});

test("returns API_UNREACHABLE when API is down", async () => {
  const stderr = createWriter();
  const exitCode = await runPcCli(["ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 4);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "API_UNREACHABLE");
});

test("ls passes through recurrence iteration limit errors", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runPcCli(["ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () =>
      jsonResponse(422, {
        error: {
          code: "RECURRENCE_ITERATION_LIMIT",
          message: "Recurrence expansion exceeded the candidate iteration limit",
          requestId: "req-recurrence-cap",
          details: {
            maxIterations: 50000,
          },
        },
      }, [["x-request-id", "req-recurrence-cap"]]),
    stdout,
    stderr,
  });

  assert.equal(exitCode, 5);
  assert.equal(stdout.value(), "");
  assert.deepEqual(JSON.parse(stderr.value()), {
    error: {
      code: "RECURRENCE_ITERATION_LIMIT",
      message: "Recurrence expansion exceeded the candidate iteration limit",
      details: {
        maxIterations: 50000,
        requestId: "req-recurrence-cap",
      },
    },
  });
});

test("CLI error output sanitizes raw upstream payload details", async () => {
  const stderr = createWriter();
  const exitCode = await runPcCli(["ls", "--start", "2026-07-01T00:00:00Z", "--end", "2026-07-02T00:00:00Z"], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => jsonResponse(502, {
      error: {
        code: "UPSTREAM_ERROR",
        message: "Upstream request failed",
        requestId: "request-from-body",
        details: {
          status: 502,
          payload: {
            Code: 9001,
            Error: "REFRESH-secret leaked upstream message",
            Details: {
              Cookie: "AUTH-uid-123=auth-secret",
            },
          },
        },
      },
    }, [["x-request-id", "request-from-header"]]),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 5);
  const serialized = stderr.value();
  const payload = JSON.parse(serialized);
  assert.equal(payload.error.code, "UPSTREAM_ERROR");
  assert.deepEqual(payload.error.details, { status: 502, code: 9001, requestId: "request-from-header" });
  assert.equal(serialized.includes("REFRESH-secret"), false);
  assert.equal(serialized.includes("auth-secret"), false);
  assert.equal(serialized.includes("payload"), false);
});

test("partial ICS import failures use upstream exit code", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-cli-partial-import-test-"));
  const icsPath = path.join(tmpDir, "calendar.ics");
  await writeFile(icsPath, "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
  const stderr = createWriter();
  const exitCode = await runPcCli(["import", icsPath], {
    env: {
      PC_API_BASE_URL: "http://127.0.0.1:8787",
      PC_API_TOKEN: "token",
    },
    fetchImpl: async () => jsonResponse(502, {
      error: {
        code: "ICS_IMPORT_PARTIAL_FAILURE",
        message: "ICS import stopped after creating some events; manual cleanup may be required",
      },
    }),
    stdout: createWriter(),
    stderr,
  });

  assert.equal(exitCode, 5);
  assert.equal(JSON.parse(stderr.value()).error.code, "ICS_IMPORT_PARTIAL_FAILURE");
});

test("unexpected CLI failures keep the general failure exit code", async () => {
  const stderr = createWriter();
  const exitCode = await runPcCli(["--help"], {
    stdout: {
      write() {
        throw new Error("stdout closed");
      },
    },
    stderr,
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(JSON.parse(stderr.value()), {
    error: {
      code: "INTERNAL_ERROR",
      message: "stdout closed",
    },
  });
});

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

function execFileResult(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

function minimalProcessEnv(values = {}) {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return { ...env, ...values };
}

function jsonResponse(status, payload, headers = []) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
  });
}

function textResponse(status, text) {
  return new Response(text, { status });
}

function binaryResponse(status, data) {
  return new Response(data, { status });
}

function sha256ForTest(data) {
  return createHash("sha256").update(data).digest("hex");
}

function releaseFetch(options) {
  const assetName = options.assetName || "pc-linux-x64";
  const checksumName = `${assetName}.sha256`;
  const binary = options.binary || Buffer.from("new-binary");
  return async (url) => {
    const rawUrl = String(url);
    options.requestedUrls?.push(rawUrl);
    if (rawUrl.includes("api.github.com/repos/hacker-h/proton-calendar-cli/releases/")) {
      return jsonResponse(200, {
        tag_name: "v1.9.0",
        assets: [
          {
            name: assetName,
            size: binary.length,
            browser_download_url: `https://downloads.example/${assetName}`,
          },
          {
            name: checksumName,
            size: 64,
            browser_download_url: `https://downloads.example/${checksumName}`,
          },
        ],
      });
    }
    if (rawUrl === `https://downloads.example/${checksumName}`) {
      return textResponse(200, `${options.checksum}  ${assetName}\n`);
    }
    if (rawUrl === `https://downloads.example/${assetName}`) {
      return binaryResponse(200, binary);
    }
    throw new Error(`Unexpected update fetch: ${rawUrl}`);
  };
}

async function writeLoginCookieBundle(cookieBundlePath) {
  await writeFile(
    cookieBundlePath,
    `${JSON.stringify({
      cookies: [
        {
          name: "pm-session",
          value: "valid-session",
          domain: "calendar.proton.me",
          path: "/",
          secure: false,
        },
      ],
      uidCandidates: ["uid-1"],
    }, null, 2)}\n`
  );
  await chmod(cookieBundlePath, 0o600);
}

function loginFetchWithCalendars(calendars) {
  return async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/core/v4/users") {
      return jsonResponse(200, { Code: 1000, User: { ID: "user-1" } });
    }
    if (parsed.pathname === "/api/calendar/v1") {
      return jsonResponse(200, { Code: 1000, Calendars: calendars });
    }
    return jsonResponse(404, { Code: 404, Error: "not found" });
  };
}
