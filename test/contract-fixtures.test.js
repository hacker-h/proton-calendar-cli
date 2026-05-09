import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPcCli } from "../src/cli.js";
import { startApiServer } from "../src/server.js";
import { ApiError } from "../src/errors.js";

test("CLI golden fixtures lock stdout stderr and exit code contracts", async () => {
  const fixture = await readFixture("cli.json");

  for (const contract of fixture.cases) {
    await test(contract.name, async () => {
      const stdout = createWriter();
      const stderr = createWriter();
      const requests = [];

      const exitCode = await runPcCli(contract.argv, {
        env: {
          PC_API_BASE_URL: "http://127.0.0.1:8787",
          PC_API_TOKEN: "test-token",
        },
        now: contract.now ? () => Date.parse(contract.now) : undefined,
        fetchImpl: createCliFetch(contract, requests),
        stdout,
        stderr,
      });

      assert.equal(exitCode, contract.expected.exitCode);
      assertCliStreams({ stdout: stdout.value(), stderr: stderr.value() }, contract.expected);
      assertExpectedRequest(requests, contract.expectedRequest);
    });
  }
});

test("doctor auth golden fixture locks refresh recovery output", async () => {
  const fixture = await readFixture("cli.json");
  const contract = fixture.doctorRefreshRecovered;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-contract-doctor-"));
  const cookieBundlePath = path.join(tmpDir, "cookies.json");

  await writeFile(cookieBundlePath, `${JSON.stringify(createDoctorCookieBundle(), null, 2)}\n`);

  const stdout = createWriter();
  const stderr = createWriter();
  const argv = contract.argv.map((value) => (value === "<cookie-bundle>" ? cookieBundlePath : value));

  const exitCode = await runPcCli(argv, {
    env: {},
    fetchImpl: createDoctorRefreshFetch(),
    stdout,
    stderr,
  });

  assert.equal(exitCode, contract.expected.exitCode);
  const normalizedExpected = replaceDeep(contract.expected.stdout, "<cookie-bundle>", cookieBundlePath);
  assert.deepEqual(normalizeDoctorPayload(parseJson(stdout.value()), cookieBundlePath), normalizeDoctorPayload(normalizedExpected, cookieBundlePath));
  assert.equal(stderr.value(), contract.expected.stderr);
});

test("API golden fixtures lock success and error envelopes", async () => {
  const fixture = await readFixture("api.json");
  const setup = await startContractApi(fixture);

  try {
    await assertApiContract(setup, fixture.health);
    await assertApiContract(setup, fixture.authStatus);
    for (const contract of fixture.crud) {
      await assertApiContract(setup, contract);
    }
    await assertApiContract(setup, fixture.recurrence);
    for (const contract of fixture.errors) {
      await assertApiContract(setup, contract);
    }
  } finally {
    await setup.close();
  }
});

async function readFixture(name) {
  const content = await readFile(new URL(`./fixtures/contract/${name}`, import.meta.url), "utf8");
  return JSON.parse(content);
}

function createCliFetch(contract, requests) {
  return async (url, init = {}) => {
    const parsedUrl = new URL(String(url));
    requests.push({
      method: init.method || "GET",
      pathname: parsedUrl.pathname,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
      headers: init.headers || {},
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (contract.networkError) {
      throw new Error(contract.networkError);
    }

    return jsonResponse(contract.apiResponse.status, contract.apiResponse.body);
  };
}

function assertCliStreams(streams, expected) {
  if (expected.exitCode === 0) {
    assert.equal(streams.stderr, "");
    const payload = parseJson(streams.stdout);
    assert.deepEqual(Object.keys(payload), ["data"]);
    assert.deepEqual(payload, expected.stdout);
    return;
  }

  assert.equal(streams.stdout, "");
  const payload = parseJson(streams.stderr);
  assert.deepEqual(Object.keys(payload), ["error"]);
  assert.equal(typeof payload.error.code, "string");
  assert.equal(typeof payload.error.message, "string");
  assert.deepEqual(payload, expected.stderr);
}

function assertExpectedRequest(requests, expectedRequest) {
  if (!expectedRequest) {
    assert.equal(requests.length, 0);
    return;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, expectedRequest.method);
  assert.equal(requests[0].pathname, expectedRequest.pathname);
  if (expectedRequest.query) {
    assert.deepEqual(requests[0].query, expectedRequest.query);
  }
  if (expectedRequest.body) {
    assert.deepEqual(requests[0].body, expectedRequest.body);
  }
}

function createDoctorCookieBundle() {
  return {
    source: "contract-fixture",
    uidCandidates: ["uid-1"],
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "stale",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true
      },
      {
        name: "REFRESH-uid-1",
        value: "%7B%22ResponseType%22%3A%22token%22%2C%22GrantType%22%3A%22refresh_token%22%2C%22RefreshToken%22%3A%22refresh-fixture%22%2C%22UID%22%3A%22uid-1%22%7D",
        domain: "calendar.proton.me",
        path: "/api/auth/refresh",
        secure: true
      }
    ]
  };
}

function createDoctorRefreshFetch() {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const cookieHeader = String(init.headers?.Cookie || "");

    if (parsed.pathname === "/api/calendar/v1") {
      if (cookieHeader.includes("AUTH-uid-1=fresh")) {
        return jsonResponse(200, { Code: 1000, Calendars: [{ ID: "assistant-calendar" }] });
      }
      return jsonResponse(401, { Code: 2001, Error: "Unauthorized" });
    }

    if (parsed.pathname === "/api/auth/v4/refresh" || parsed.pathname === "/api/auth/refresh") {
      return jsonResponse(
        200,
        { Code: 1000 },
        [["set-cookie", "AUTH-uid-1=fresh; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly; SameSite=None"]]
      );
    }

    return jsonResponse(404, { Code: 404, Error: "not found" });
  };
}

async function startContractApi(fixture) {
  return startApiServer(
    {
      port: 8787,
      targetCalendarId: "assistant-calendar",
      defaultCalendarId: "assistant-calendar",
      allowedCalendarIds: ["assistant-calendar"],
      apiBearerToken: "test-token",
      cookieBundlePath: "test/fixtures/contract/cookies.json",
      protonBaseUrl: "https://calendar.proton.me",
      protonTimeoutMs: 3000,
      protonMaxRetries: 0,
    },
    { port: 0, service: createContractService(fixture) }
  );
}

function createContractService(fixture) {
  let event = null;
  let authStatusCalls = 0;
  const createFixture = fixture.crud.find((item) => item.name === "create event");
  const editFixture = fixture.crud.find((item) => item.name === "edit event");
  const deleteFixture = fixture.crud.find((item) => item.name === "delete event");

  return {
    async authStatus() {
      authStatusCalls += 1;
      if (authStatusCalls > 1) {
        throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized", { reloginRequired: true });
      }
      return fixture.authStatus.expected.body.data;
    },
    async listEvents(input) {
      if (input.start === "2026-05-01T00:00:00.000Z") {
        throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend", { cause: "network" });
      }
      if (input.start === "2026-04-06T00:00:00.000Z") {
        return fixture.recurrence.expected.body.data;
      }
      return {
        events: event ? [event] : [],
        nextCursor: null,
      };
    },
    async createEvent(body) {
      if (body.title === undefined) {
        throw new ApiError(400, "INVALID_PAYLOAD", "title must be a string");
      }
      assert.deepEqual(body, createFixture.request.body);
      event = createFixture.expected.body.data;
      return event;
    },
    async updateEvent(eventId, body) {
      assert.equal(eventId, "evt-1");
      assert.deepEqual(body, editFixture.request.body);
      event = editFixture.expected.body.data;
      return event;
    },
    async deleteEvent(eventId) {
      assert.equal(eventId, "evt-1");
      event = null;
      return deleteFixture.expected.body.data;
    },
  };
}

async function assertApiContract(setup, contract) {
  const response = await fetch(`${setup.baseUrl}${contract.request.route}`, {
    method: contract.request.method,
    headers: buildApiHeaders(contract.request),
    body: buildApiBody(contract.request),
  });
  const body = normalizeApiBody(await response.json());

  assert.equal(response.status, contract.expected.status, contract.name || contract.request.route);
  assert.deepEqual(body, contract.expected.body, contract.name || contract.request.route);
  if (response.ok) {
    assert.deepEqual(Object.keys(body), ["data"]);
  } else {
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
  }
}

function buildApiHeaders(request) {
  const headers = {
    "Content-Type": "application/json",
    "X-Idempotency-Key": "contract-fixture-key",
  };
  if (request.auth !== false) {
    headers.Authorization = "Bearer test-token";
  }
  return headers;
}

function buildApiBody(request) {
  if (request.rawBody !== undefined) {
    return request.rawBody;
  }
  if (request.body !== undefined) {
    return JSON.stringify(request.body);
  }
  return undefined;
}

function normalizeApiBody(body) {
  if (body?.data?.requestId) {
    return {
      ...body,
      data: {
        ...body.data,
        requestId: "<request-id>",
      },
    };
  }
  return body;
}

function normalizeDoctorPayload(payload, cookieBundlePath) {
  return replaceDeep(payload, cookieBundlePath, "<cookie-bundle>");
}

function replaceDeep(value, needle, replacement) {
  if (Array.isArray(value)) {
    return value.map((item) => replaceDeep(item, needle, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, needle, replacement)]));
  }
  return value === needle ? replacement : value;
}

function parseJson(value) {
  assert.notEqual(value, "");
  return JSON.parse(value);
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

function jsonResponse(status, payload, headers = []) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: [["Content-Type", "application/json"], ...headers],
  });
}
