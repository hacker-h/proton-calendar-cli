#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultEnvFile = "encrypted/local-live.env";
const gitCryptMagic = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);
const requiredSecrets = ["PROTON_USERNAME", "PROTON_PASSWORD"];
const optionalSecrets = ["PROTON_TEST_CALENDAR_ID"];

export async function runSyncGithubSecrets(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const readFileImpl = options.readFileImpl || readFile;
  const spawnImpl = options.spawnImpl || spawn;
  const stdout = options.stdout || process.stdout;
  const envFile = path.resolve(argv[0] || defaultEnvFile);
  const raw = await readFileImpl(envFile);

  if (isGitCryptLocked(raw)) {
    throw new Error(`${envFile} is still git-crypt locked. Run git-crypt unlock before syncing GitHub secrets.`);
  }

  const env = parseEnv(toBuffer(raw).toString("utf8"));
  const names = [...requiredSecrets, ...optionalSecrets].filter((name) => env[name]);

  for (const name of requiredSecrets) {
    if (!env[name]) {
      throw new Error(`${name} is missing from ${envFile}`);
    }
  }

  for (const name of names) {
    await setGitHubSecret(name, env[name], spawnImpl);
    stdout.write(`Set GitHub secret ${name}\n`);
  }
}

export function isGitCryptLocked(raw) {
  const buffer = toBuffer(raw);
  if (buffer.length < gitCryptMagic.length) {
    return false;
  }
  return buffer.subarray(0, gitCryptMagic.length).equals(gitCryptMagic);
}

function parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function setGitHubSecret(name, value, spawnImpl) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl("gh", ["secret", "set", name], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`gh secret set ${name} failed with exit code ${code}: ${stderr.trim()}`));
    });

    child.stdin.end(value);
  });
}

function toBuffer(raw) {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isEntrypoint) {
  runSyncGithubSecrets().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
