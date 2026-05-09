import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPcCli } from "../src/cli.js";

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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "EMPTY_PATCH");
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

    assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
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

  assert.equal(exitCode, 1);
  const payload = JSON.parse(stderr.value());
  assert.equal(payload.error.code, "API_UNREACHABLE");
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

function jsonResponse(status, payload, headers = []) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
  });
}
