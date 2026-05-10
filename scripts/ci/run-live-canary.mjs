#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const DEFAULT_ENV_PATH = "secrets/ci-live.env";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_HEALTH_TIMEOUT_MS = 45000;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export async function main(env = process.env) {
  const envPath = path.resolve(env.CI_LIVE_ENV_PATH || DEFAULT_ENV_PATH);

  await runCommand(process.execPath, ["scripts/ci/bootstrap-proton-session.mjs"], { env });
  await runCommand(process.execPath, ["scripts/ci/write-live-env.mjs"], { env });

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
    await waitForApi(apiBaseUrl, readPositiveNumber(liveEnv.CI_LIVE_API_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS));
    await runCommand(pnpmCommand(), ["run", "test:live"], { env: liveEnv });
  } finally {
    await stopServer(server);
  }
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
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal || code}`));
    });
  });
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
