#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { assertSafeDiagnostics } from "./bootstrap-proton-session.mjs";

const DEFAULT_ENV_PATH = "secrets/ci-live.env";
const DEFAULT_TRIAGE_PATH = "reports/live-triage.json";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_HEALTH_TIMEOUT_MS = 45000;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const quarantine = await readLiveQuarantine(process.env.CI_LIVE_QUARANTINE_PATH).catch((quarantineError) => ({
      active: [],
      invalid: [{ reason: quarantineError?.message || String(quarantineError) }],
    }));
    let triage = classifyLiveCanaryFailure(error, { quarantine });
    try {
      assertSafeLiveTriage(triage);
    } catch {
      triage = classifyLiveCanaryFailure({ stage: "triage-sanitizer", exitCode: 80 }, { quarantine: { active: [], invalid: [] } });
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
  } finally {
    await stopServer(server);
  }
}

export function classifyLiveCanaryFailure(error, options = {}) {
  const stage = error?.stage || "unknown";
  const bootstrapCode = stage === "bootstrap" ? Number(error?.exitCode) : Number.NaN;
  const mapped = Number.isFinite(bootstrapCode) ? classifyBootstrapExitCode(bootstrapCode) : classifyStage(stage);
  const quarantine = options.quarantine || { active: [], invalid: [] };
  const quarantineMatches = quarantine.active.filter((entry) => entry.failureClass === mapped.failureClass);

  return {
    failureClass: mapped.failureClass,
    stage,
    exitCode: Number.isFinite(Number(error?.exitCode)) ? Number(error.exitCode) : null,
    signal: error?.signal || null,
    command: error?.command || null,
    nextAction: mapped.nextAction,
    quarantineEligible: mapped.quarantineEligible,
    quarantineRequiredFields: ["id", "suite", "check", "failureClass", "owner", "reason", "expiresAt", "issue"],
    quarantineMatches,
    invalidQuarantines: quarantine.invalid,
    failureSuppressed: false,
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
      invalid.push({ id: normalized.id, reason: "unsafe quarantine metadata" });
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
    10: ["credential_config", "Configure PROTON_USERNAME and PROTON_PASSWORD as protected live canary secrets.", false],
    20: ["runner_browser", "Check Playwright/Chromium installation and runner browser dependencies.", true],
    30: ["runner_or_proton_availability", "Check runner network and Proton availability before retrying.", true],
    40: ["credential_auth", "Rotate or repair the dedicated Proton live canary credentials.", false],
    50: ["credential_auth_human_required", "Human intervention is required; do not loop browser logins.", false],
    60: ["proton_ui_drift", "Inspect sanitized bootstrap logs and update Proton login selectors if needed.", true],
    70: ["credential_or_proton_session_drift", "Check session export and Proton calendar auth shape.", true],
    80: ["security_sanitizer", "Review sanitizer failure before publishing logs or artifacts.", false],
  };
  const [failureClass, nextAction, quarantineEligible] = map[exitCode] || [
    "unknown_bootstrap_failure",
    "Inspect sanitized bootstrap diagnostics and classify before retrying.",
    true,
  ];
  return { failureClass, nextAction, quarantineEligible };
}

function classifyStage(stage) {
  const map = {
    "browser-install": ["runner_browser", "Check Playwright/Chromium installation and runner browser dependencies.", true],
    "write-live-env": ["live_env_setup", "Check live env generation inputs and cookie probe metadata.", false],
    "triage-sanitizer": ["security_sanitizer", "Review sanitizer failure before publishing logs or artifacts.", false],
    "api-start": ["runner_or_api_start", "Check local API startup logs, port availability, and generated live env.", true],
    "live-tests": ["project_regression_or_proton_drift", "Inspect failing live test, affected endpoint, and last passing run.", true],
  };
  const [failureClass, nextAction, quarantineEligible] = map[stage] || [
    "unknown_live_canary_failure",
    "Inspect sanitized canary logs and assign a failure class before retrying.",
    true,
  ];
  return { failureClass, nextAction, quarantineEligible };
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
