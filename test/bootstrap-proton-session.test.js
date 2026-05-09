import test from "node:test";
import assert from "node:assert/strict";
import {
  BootstrapError,
  assertSafeDiagnostics,
  classifyLoginError,
  normalizeBootstrapError,
  parseArgs,
  safeUrlSummary,
  sanitizeSuccessSummary,
} from "../scripts/ci/bootstrap-proton-session.mjs";

test("parseArgs reports missing CI login secrets with stable class", () => {
  assert.throws(
    () => parseArgs([], {}),
    (error) => {
      assert.equal(error instanceof BootstrapError, true);
      assert.equal(error.code, "CONFIG_MISSING");
      assert.equal(error.exitCode, 10);
      assert.equal(error.details.missing, "PROTON_USERNAME");
      return true;
    }
  );
});

test("login error classification separates credentials from challenges", () => {
  const badCredentials = classifyLoginError("Incorrect login credentials", "login");
  assert.equal(badCredentials.code, "BAD_CREDENTIALS");
  assert.equal(badCredentials.exitCode, 40);

  const rateLimited = classifyLoginError("Too many attempts, try again later", "login");
  assert.equal(rateLimited.code, "INTERACTIVE_CHALLENGE");
  assert.equal(rateLimited.details.challenge, "rate_limited");
});

test("safeUrlSummary strips query strings and external URLs", () => {
  assert.deepEqual(safeUrlSummary("https://calendar.proton.me/u/0?token=secret#x"), {
    host: "calendar.proton.me",
    path: "/u/0",
  });
  assert.deepEqual(safeUrlSummary("https://example.test/path?token=secret"), {
    host: "external",
    path: "/",
  });
});

test("success summary excludes UID and cookie values", () => {
  const summary = sanitizeSuccessSummary(
    {
      source: "playwright-ci",
      loginUrl: "https://account.proton.me/login?secret=value",
      cookies: [
        { name: "AUTH-uid-1", value: "auth-secret" },
        { name: "REFRESH-uid-1", value: "refresh-secret" },
      ],
      uidCandidates: ["uid-1"],
      persistedSessions: { "ps-1": { UID: "uid-1", blob: "session-secret" } },
      authProbe: { host: "https://calendar.proton.me", uid: "uid-1", calendarCount: 2, calendarIds: ["cal-1"] },
    },
    { outputFile: "/tmp/proton-cookies.json" }
  );

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("auth-secret"), false);
  assert.equal(serialized.includes("refresh-secret"), false);
  assert.equal(serialized.includes("uid-1"), false);
  assert.equal(serialized.includes("session-secret"), false);
  assert.equal(serialized.includes("cal-1"), false);
  assert.equal(summary.uidCandidateCount, 1);
  assert.deepEqual(summary.cookieNames, ["AUTH-<redacted>", "REFRESH-<redacted>"]);
});

test("diagnostic sanitizer blocks obvious secret payloads", () => {
  assert.throws(() => assertSafeDiagnostics({ cookie: { value: "secret" } }), BootstrapError);
  assert.doesNotThrow(() => assertSafeDiagnostics({ data: { cookieCount: 2, uidCandidateCount: 1 } }));
});

test("unknown timeouts normalize to stable timeout class", () => {
  const normalized = normalizeBootstrapError(new Error("navigation timed out"));
  assert.equal(normalized.code, "NETWORK_TIMEOUT");
  assert.equal(normalized.exitCode, 30);
});
