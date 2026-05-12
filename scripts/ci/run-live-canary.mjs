#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { assertSafeDiagnostics } from "./bootstrap-proton-session.mjs";

const DEFAULT_ENV_PATH = "secrets/ci-live.env";
const DEFAULT_TRIAGE_PATH = "reports/live-triage.json";
const DEFAULT_DRIFT_BASELINE_PATH = "test/fixtures/live-drift-baseline.json";
const DEFAULT_DRIFT_REPORT_PATH = "reports/live-drift.json";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_HEALTH_TIMEOUT_MS = 45000;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const quarantine = await readLiveQuarantine(process.env.CI_LIVE_QUARANTINE_PATH).catch((quarantineError) => ({
      active: [],
      invalid: [{ reason: quarantineError?.message || String(quarantineError) }],
    }));
    let triage = classifyLiveCanaryFailure(error, { env: process.env, quarantine });
    try {
      assertSafeLiveTriage(triage);
    } catch {
      triage = classifyLiveCanaryFailure({ stage: "triage-sanitizer", exitCode: 80 }, { env: process.env, quarantine: { active: [], invalid: [] } });
    }
    await writeLiveTriageReport(triage, process.env).catch((reportError) => {
      console.error(`Unable to write live triage report: ${reportError?.message || String(reportError)}`);
    });
    console.error(JSON.stringify({
      error: {
        code: "LIVE_CANARY_FAILED",
        message: "Live Proton canary failed; inspect triage details before retrying.",
        details: triage,
      },
    }, null, 2));
    process.exit(1);
  });
}

export async function main(env = process.env) {
  const envPath = path.resolve(env.CI_LIVE_ENV_PATH || DEFAULT_ENV_PATH);
  const quarantine = await readLiveQuarantine(env.CI_LIVE_QUARANTINE_PATH);
  if (quarantine.active.length > 0 || quarantine.invalid.length > 0) {
    console.log(JSON.stringify({ data: { liveQuarantine: quarantine } }, null, 2));
  }

  await runStage("browser-install", () => runCommand(pnpmCommand(), ["exec", "playwright", "install", "chromium", "--with-deps"], { env }));
  await runStage("bootstrap", () => runCommand(process.execPath, ["scripts/ci/bootstrap-proton-session.mjs"], { env }));
  await runStage("write-live-env", () => runCommand(process.execPath, ["scripts/ci/write-live-env.mjs"], { env }));

  const liveEnv = {
    ...env,
    ...parseEnvFile(await readFile(envPath, "utf8")),
  };

  const apiBaseUrl = String(liveEnv.PC_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const server = spawn(process.execPath, ["src/index.js"], {
    env: liveEnv,
    stdio: "inherit",
  });

  try {
    await runStage("api-start", () => waitForApi(apiBaseUrl, readPositiveNumber(liveEnv.CI_LIVE_API_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS)));
    await runStage("live-tests", () => runCommand(pnpmCommand(), ["run", "test:live"], { env: liveEnv }));
    await runStage("drift-snapshot", () => runLiveDriftSnapshot({ apiBaseUrl, env: liveEnv }));
  } finally {
    await stopServer(server);
  }
}

export function classifyLiveCanaryFailure(error, options = {}) {
  const stage = error?.stage || "unknown";
  const bootstrapCode = stage === "bootstrap" ? Number(error?.exitCode) : Number.NaN;
  const mapped = Number.isFinite(bootstrapCode) ? classifyBootstrapExitCode(bootstrapCode) : classifyStage(stage);
  const quarantine = options.quarantine || { active: [], invalid: [] };
  const quarantineMatches = quarantine.active.filter((entry) => matchesQuarantine(entry, mapped));

  return {
    failureClass: mapped.failureClass,
    stage,
    suite: mapped.suite,
    check: mapped.check,
    exitCode: Number.isFinite(Number(error?.exitCode)) ? Number(error.exitCode) : null,
    signal: error?.signal || null,
    command: error?.command || null,
    nextAction: mapped.nextAction,
    quarantineEligible: mapped.quarantineEligible,
    quarantineRequiredFields: ["id", "suite", "check", "failureClass", "owner", "reason", "expiresAt", "issue"],
    quarantineMatches,
    invalidQuarantines: quarantine.invalid,
    failureSuppressed: false,
    triageTemplate: {
      command: error?.command || null,
      requestId: null,
      logExcerpt: null,
      affectedEndpoint: mapped.affectedEndpoint,
      affectedFeature: mapped.affectedFeature,
      lastPassingRun: null,
      runUrl: buildGitHubRunUrl(options.env),
      owner: quarantineMatches[0]?.owner || null,
      expiresAt: quarantineMatches[0]?.expiresAt || null,
      issue: quarantineMatches[0]?.issue || null,
    },
  };
}

export function parseLiveQuarantine(raw, now = new Date()) {
  if (!String(raw || "").trim()) {
    return { active: [], invalid: [] };
  }

  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.quarantines) ? parsed.quarantines : [];
  const active = [];
  const invalid = [];

  for (const entry of entries) {
    const normalized = normalizeQuarantineEntry(entry);
    const missing = ["id", "suite", "check", "failureClass", "owner", "reason", "expiresAt", "issue"].filter(
      (key) => !normalized[key]
    );
    const expiresAtMs = Date.parse(normalized.expiresAt);
    if (!isSafeQuarantineEntry(normalized)) {
      invalid.push({ reason: "unsafe quarantine metadata" });
      continue;
    }

    if (missing.length > 0) {
      invalid.push({ ...normalized, reason: "missing required quarantine fields", missing });
      continue;
    }
    if (Number.isNaN(expiresAtMs)) {
      invalid.push({ ...normalized, reason: "invalid quarantine expiry" });
      continue;
    }
    if (expiresAtMs <= now.getTime()) {
      invalid.push({ ...normalized, reason: "expired quarantine" });
      continue;
    }

    active.push(normalized);
  }

  return { active, invalid };
}

export function parseEnvFile(raw) {
  const values = {};
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    values[trimmed.slice(0, equals)] = parseEnvValue(trimmed.slice(equals + 1));
  }
  return values;
}

export function buildDriftShape(value) {
  if (value === null) {
    return { type: "null" };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length === 0 ? { type: "unknown" } : buildDriftShape(value[0]),
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, buildDriftShape(value[key])])
      ),
    };
  }
  return { type: typeof value };
}

export function compareLiveDriftSnapshots(baseline, current) {
  const differences = [];
  const expectedSurfaces = new Map((baseline.surfaces || []).map((surface) => [surface.id, surface]));
  const currentSurfaces = new Map((current.surfaces || []).map((surface) => [surface.id, surface]));

  for (const [id, expected] of expectedSurfaces) {
    const actual = currentSurfaces.get(id);
    if (!actual) {
      differences.push(buildDriftDifference(id, expected.endpoint, "missing_surface", "breaking", "Surface was not captured"));
      continue;
    }
    if (expected.status !== undefined && actual.status !== expected.status) {
      differences.push(buildDriftDifference(id, expected.endpoint, "status_changed", "breaking", `HTTP status changed from ${expected.status} to ${actual.status}`));
    }
    compareShape(expected.shape, actual.shape, { surface: id, endpoint: expected.endpoint, path: "response", differences });
  }

  for (const [id, actual] of currentSurfaces) {
    if (!expectedSurfaces.has(id)) {
      differences.push(buildDriftDifference(id, actual.endpoint, "added_surface", "additive", "New surface was captured"));
    }
  }

  return differences;
}

export function buildLiveDriftReport({ baseline, current, env = {} }) {
  const differences = compareLiveDriftSnapshots(baseline, current);
  const breaking = differences.filter((difference) => difference.severity === "breaking");
  return {
    failureClass: breaking.length > 0 ? "proton_api_drift" : null,
    runUrl: buildGitHubRunUrl(env),
    nextAction: breaking.length > 0
      ? "Review missing/type drift, update the Proton adapter or refresh the sanitized baseline after confirming compatibility."
      : "No breaking Proton API drift detected; review additive differences during maintenance.",
    summary: {
      surfacesChecked: current.surfaces.length,
      breakingDifferences: breaking.length,
      additiveDifferences: differences.length - breaking.length,
    },
    differences,
    current,
  };
}

export function assertSafeLiveDriftReport(report) {
  const serialized = JSON.stringify(report);
  if (/rawPayload|AUTH-[A-Za-z0-9_-]+|REFRESH-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|"cookie"\s*:\s*\{[^}]*"value"|"blob"\s*:/i.test(serialized)) {
    throw new LiveDriftSafetyError();
  }
}

async function waitForApi(apiBaseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBaseUrl}/v1/health`, {
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`API health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }

  throw lastError || new Error("API did not become ready in time");
}

function sanitizeDriftSnapshot(snapshot) {
  return {
    ...snapshot,
    surfaces: (snapshot.surfaces || []).map(({ rawPayload: _raw, ...rest }) => rest),
  };
}

async function runLiveDriftSnapshot({ apiBaseUrl, env }) {
  const baselinePath = path.resolve(env.CI_LIVE_DRIFT_BASELINE_PATH || DEFAULT_DRIFT_BASELINE_PATH);
  const reportPath = path.resolve(env.CI_LIVE_DRIFT_REPORT_PATH || DEFAULT_DRIFT_REPORT_PATH);
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const rawCurrent = await captureLiveDriftSnapshot({ apiBaseUrl, env });
  // Strip rawPayload before building the report; it must never appear in sanitized output.
  const current = sanitizeDriftSnapshot(rawCurrent);
  const report = buildLiveDriftReport({ baseline, current, env });

  assertSafeLiveDriftReport(report);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ data: report }, null, 2)}\n`, { mode: 0o600 });

  if (report.summary.breakingDifferences > 0) {
    throw new LiveDriftError(report);
  }
}

async function captureLiveDriftSnapshot({ apiBaseUrl, env }) {
  const token = String(env.PC_API_TOKEN || env.API_BEARER_TOKEN || "").trim();
  const calendarId = String(env.PROTON_TEST_CALENDAR_ID || env.TARGET_CALENDAR_ID || env.DEFAULT_CALENDAR_ID || "").trim() || null;
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const surfaces = [];

  // Required read-only surfaces
  for (const request of [
    { id: "auth.status", method: "GET", endpoint: "/v1/auth/status" },
    { id: "calendars.list", method: "GET", endpoint: "/v1/calendars" },
    { id: "events.list", method: "GET", endpoint: `/v1/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=1` },
  ]) {
    surfaces.push(await captureDriftSurface(apiBaseUrl, token, request));
  }

  // Optional scoped list (when calendar id available)
  if (calendarId) {
    surfaces.push(await captureDriftSurface(apiBaseUrl, token, {
      id: "calendar.events.list",
      method: "GET",
      endpoint: `/v1/calendars/${encodeURIComponent(calendarId)}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=1`,
    }));
  }

  // Optional single-event GET from the generic list result (no mutations required)
  const genericListSurface = surfaces.find((s) => s.id === "events.list");
  const firstEventId = extractFirstEventId(genericListSurface?.rawPayload);
  if (firstEventId) {
    surfaces.push(await captureDriftSurface(apiBaseUrl, token, {
      id: "events.get",
      method: "GET",
      endpoint: `/v1/events/${encodeURIComponent(firstEventId)}`,
    }));
    if (calendarId) {
      surfaces.push(await captureDriftSurface(apiBaseUrl, token, {
        id: "calendar.events.get",
        method: "GET",
        endpoint: `/v1/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(firstEventId)}`,
      }));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    surfaces,
  };
}

function extractFirstEventId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const events = Array.isArray(payload?.data?.events) ? payload.data.events : [];
  const first = events[0];
  return first && typeof first.id === "string" && first.id ? first.id : null;
}

async function captureDriftSurface(apiBaseUrl, token, request) {
  const response = await fetch(`${apiBaseUrl}${request.endpoint}`, {
    method: request.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => null);
  return {
    id: request.id,
    method: request.method,
    endpoint: request.endpoint.replace(/\?.*$/, ""),
    status: response.status,
    shape: buildDriftShape(payload),
    rawPayload: payload,
  };
}

function compareShape(expected, actual, context) {
  if (!actual) {
    context.differences.push(buildDriftDifference(context.surface, context.endpoint, "missing_field", "breaking", `${context.path} is missing`));
    return;
  }
  if (expected.type !== actual.type && expected.type !== "unknown") {
    context.differences.push(buildDriftDifference(context.surface, context.endpoint, "type_changed", "breaking", `${context.path} changed from ${expected.type} to ${actual.type}`));
    return;
  }
  if (expected.type === "object") {
    const expectedKeys = expected.keys || {};
    const actualKeys = actual.keys || {};
    for (const [key, expectedValue] of Object.entries(expectedKeys)) {
      compareShape(expectedValue, actualKeys[key], { ...context, path: `${context.path}.${key}` });
    }
    for (const key of Object.keys(actualKeys)) {
      if (!Object.hasOwn(expectedKeys, key)) {
        context.differences.push(buildDriftDifference(context.surface, context.endpoint, "added_field", "additive", `${context.path}.${key} was added`));
      }
    }
  }
  if (expected.type === "array") {
    // When expected items type is "unknown" we do not validate item shape (baseline was captured
    // from an empty array). When actual items type is "unknown" the live array was empty so there
    // is nothing to compare; report as informational, not breaking.
    if (expected.items?.type === "unknown") {
      if (actual.items?.type !== "unknown") {
        context.differences.push(buildDriftDifference(context.surface, context.endpoint, "added_field", "additive", `${context.path}[] item shape now available (baseline captured from empty array)`));
      }
      return;
    }
    if (actual.items?.type === "unknown") {
      context.differences.push(buildDriftDifference(context.surface, context.endpoint, "empty_array", "additive", `${context.path}[] is empty; item shape comparison skipped`));
      return;
    }
    compareShape(expected.items, actual.items, { ...context, path: `${context.path}[]` });
  }
}

function buildDriftDifference(surface, endpoint, kind, severity, message) {
  return {
    surface,
    endpoint,
    kind,
    severity,
    message,
    likelyImpact: severity === "breaking"
      ? "Automation may fail or misinterpret Proton API responses until the adapter or baseline is reviewed."
      : "New Proton API fields are visible for maintenance review but should not break existing automation.",
  };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new LiveCommandError(command, args, code, signal));
    });
  });
}

async function runStage(stage, fn) {
  try {
    return await fn();
  } catch (error) {
    error.stage = error.stage || stage;
    throw error;
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  server.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
      resolve();
    }, 5000);
    server.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return value;
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function readLiveQuarantine(filePath) {
  if (!filePath) {
    return { active: [], invalid: [] };
  }
  return parseLiveQuarantine(await readFile(filePath, "utf8"));
}

async function writeLiveTriageReport(triage, env) {
  assertSafeLiveTriage(triage);
  const reportPath = path.resolve(env.CI_LIVE_TRIAGE_PATH || DEFAULT_TRIAGE_PATH);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ data: triage }, null, 2)}\n`, { mode: 0o600 });
}

function classifyBootstrapExitCode(exitCode) {
  const map = {
    10: ["credential_config", "bootstrap", "proton-login-config", "Configure PROTON_USERNAME and PROTON_PASSWORD as protected live canary secrets.", false],
    20: ["runner_browser", "bootstrap", "browser-setup", "Check Playwright/Chromium installation and runner browser dependencies.", true],
    30: ["runner_or_proton_availability", "bootstrap", "proton-login", "Check runner network and Proton availability before retrying.", true],
    40: ["credential_auth", "bootstrap", "proton-login", "Rotate or repair the dedicated Proton live canary credentials.", false],
    50: ["credential_auth_human_required", "bootstrap", "proton-login", "Human intervention is required; do not loop browser logins.", false],
    60: ["proton_ui_drift", "bootstrap", "proton-login", "Inspect sanitized bootstrap logs and update Proton login selectors if needed.", true],
    70: ["credential_or_proton_session_drift", "bootstrap", "calendar-session", "Check session export and Proton calendar auth shape.", true],
    80: ["security_sanitizer", "triage", "diagnostic-sanitizer", "Review sanitizer failure before publishing logs or artifacts.", false],
  };
  const [failureClass, suite, check, nextAction, quarantineEligible] = map[exitCode] || [
    "unknown_bootstrap_failure",
    "bootstrap",
    "unknown",
    "Inspect sanitized bootstrap diagnostics and classify before retrying.",
    true,
  ];
  return buildFailureMapping({ failureClass, suite, check, nextAction, quarantineEligible });
}

function classifyStage(stage) {
  const map = {
    "browser-install": ["runner_browser", "bootstrap", "browser-setup", "Check Playwright/Chromium installation and runner browser dependencies.", true],
    "write-live-env": ["live_env_setup", "live-env", "env-generation", "Check live env generation inputs and cookie probe metadata.", false],
    "triage-sanitizer": ["security_sanitizer", "triage", "diagnostic-sanitizer", "Review sanitizer failure before publishing logs or artifacts.", false],
    "api-start": ["runner_or_api_start", "live-api", "api-start", "Check local API startup logs, port availability, and generated live env.", true],
    "drift-snapshot": ["proton_api_drift", "live-drift", "schema-snapshot", "Inspect reports/live-drift.json, confirm Proton API compatibility, then update code or the sanitized baseline.", true],
    "live-tests": ["project_regression_or_proton_drift", "live-tests", "test:live", "Inspect failing live test, affected endpoint, and last passing run.", true],
  };
  const [failureClass, suite, check, nextAction, quarantineEligible] = map[stage] || [
    "unknown_live_canary_failure",
    stage || "unknown",
    "unknown",
    "Inspect sanitized canary logs and assign a failure class before retrying.",
    true,
  ];
  return buildFailureMapping({ failureClass, suite, check, nextAction, quarantineEligible });
}

function buildFailureMapping(mapping) {
  return {
    ...mapping,
    affectedEndpoint: mapping.suite === "live-api" || mapping.suite === "live-tests" ? null : "n/a",
    affectedFeature: mapping.check,
  };
}

function matchesQuarantine(entry, mapped) {
  return entry.failureClass === mapped.failureClass && entry.suite === mapped.suite && entry.check === mapped.check;
}

function buildGitHubRunUrl(env = {}) {
  const serverUrl = String(env.GITHUB_SERVER_URL || "").replace(/\/$/, "");
  const repository = String(env.GITHUB_REPOSITORY || "").trim();
  const runId = String(env.GITHUB_RUN_ID || "").trim();
  if (!serverUrl || !repository || !runId) {
    return null;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function normalizeQuarantineEntry(entry) {
  return {
    id: String(entry?.id || "").trim(),
    suite: String(entry?.suite || "").trim(),
    check: String(entry?.check || "").trim(),
    failureClass: String(entry?.failureClass || "").trim(),
    owner: String(entry?.owner || "").trim(),
    reason: String(entry?.reason || "").trim(),
    expiresAt: String(entry?.expiresAt || "").trim(),
    issue: String(entry?.issue || "").trim(),
  };
}

function isSafeQuarantineEntry(entry) {
  const serialized = JSON.stringify(entry);
  return !/API_BEARER_TOKEN|PC_API_TOKEN|COOKIE_BUNDLE_PATH|ci-live\.env|Bearer\s+[A-Za-z0-9._-]+|AUTH-[A-Za-z0-9_-]+|REFRESH-[A-Za-z0-9_-]+|"cookie"\s*:/i.test(serialized);
}

function assertSafeLiveTriage(triage) {
  assertSafeDiagnostics(triage);
  if (!isSafeQuarantineEntry(triage)) {
    throw new Error("live triage report contains unsafe metadata");
  }
}

class LiveCommandError extends Error {
  constructor(command, args, exitCode, signal) {
    super(`${command} ${args.join(" ")} failed with ${signal || exitCode}`);
    this.command = `${command} ${args.join(" ")}`;
    this.exitCode = exitCode;
    this.signal = signal || null;
  }
}

class LiveDriftError extends Error {
  constructor(report) {
    super("Proton API drift snapshot detected breaking schema differences");
    this.exitCode = 1;
    this.driftReport = report;
  }
}

class LiveDriftSafetyError extends Error {
  constructor() {
    super("Live drift report contains unsafe diagnostics");
    this.exitCode = 80;
  }
}
