#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const envFile = path.resolve(process.argv[2] || "encrypted/local-live.env");
const requiredSecrets = ["PROTON_USERNAME", "PROTON_PASSWORD"];
const optionalSecrets = ["PROTON_TEST_CALENDAR_ID"];

const env = parseEnv(await readFile(envFile, "utf8"));
const names = [...requiredSecrets, ...optionalSecrets].filter((name) => env[name]);

for (const name of requiredSecrets) {
  if (!env[name]) {
    throw new Error(`${name} is missing from ${envFile}`);
  }
}

for (const name of names) {
  await setGitHubSecret(name, env[name]);
  console.log(`Set GitHub secret ${name}`);
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

async function setGitHubSecret(name, value) {
  await new Promise((resolve, reject) => {
    const child = spawn("gh", ["secret", "set", name], {
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
