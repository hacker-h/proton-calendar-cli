#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DEFAULT_PROTON_DOMAINS,
  fetchDevtoolsTargets,
  fileExists,
  findAvailablePort,
  flattenCookies,
  looksAuthenticated,
} from "../src/proton-cookie-bootstrap.js";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_POLL_SECONDS = 3;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chromePath = options.chromePath || defaultChromePath();

  if (!chromePath || !(await fileExists(chromePath))) {
    throw new Error(
      "Chrome not found. Set --chrome-path or CHROME_PATH to your Chrome executable path."
    );
  }

  await assertSweetLinkInstalled();

  const profileDir = options.profileDir || (await mkdtemp(path.join(os.tmpdir(), "proton-cookie-profile-")));
  await mkdir(profileDir, { recursive: true });

  const devtoolsPort = await findAvailablePort();
  const loginUrl = options.loginUrl || "https://calendar.proton.me/u/0";
  const outputFile = path.resolve(options.outputFile || "secrets/proton-cookies.json");

  console.log("Opening Chrome for manual Proton login...");
  console.log(`- URL: ${loginUrl}`);
  console.log(`- Chrome: ${chromePath}`);
  console.log(`- Profile: ${profileDir}`);
  console.log(`- DevTools: http://127.0.0.1:${devtoolsPort}`);

  const chrome = launchChrome(chromePath, profileDir, devtoolsPort, loginUrl);
  let completed = false;

  try {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutSeconds * 1000;
    let warnedExportFailure = false;

    while (Date.now() - startedAt < timeoutMs) {
      let cookiesByDomain = {};
      try {
        cookiesByDomain = await exportCookiesWithSweetLink(profileDir, DEFAULT_PROTON_DOMAINS);
        warnedExportFailure = false;
      } catch (error) {
        if (!warnedExportFailure) {
          console.log("Waiting for cookie export access (check keychain/system prompts)...");
          warnedExportFailure = true;
        }
      }
      const targets = await fetchDevtoolsTargets(devtoolsPort).catch(() => []);

      if (looksAuthenticated(cookiesByDomain, targets)) {
        const payload = {
          exportedAt: new Date().toISOString(),
          source: "sweetlink",
          loginUrl,
          domains: DEFAULT_PROTON_DOMAINS,
          cookiesByDomain,
          cookies: flattenCookies(cookiesByDomain),
        };

        await mkdir(path.dirname(outputFile), { recursive: true });
        await writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        await chmod(outputFile, 0o600);

        console.log("\nLogin detected and cookies exported.");
        console.log(`- Output: ${outputFile}`);
        console.log(`- Cookies: ${payload.cookies.length}`);
        completed = true;
        break;
      }

      await delay(options.pollSeconds * 1000);
    }

    if (!completed) {
      throw new Error(
        "Timed out waiting for Proton login. Complete login in the opened Chrome window, then retry."
      );
    }
  } finally {
    await shutdownChrome(chrome);
    if (!options.keepProfile && !options.profileDir) {
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const options = {
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    pollSeconds: DEFAULT_POLL_SECONDS,
    keepProfile: false,
    outputFile: "secrets/proton-cookies.json",
    loginUrl: "https://calendar.proton.me/u/0",
    profileDir: "",
    chromePath: process.env.CHROME_PATH || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--timeout" && next) {
      options.timeoutSeconds = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--poll" && next) {
      options.pollSeconds = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--output" && next) {
      options.outputFile = next;
      i += 1;
      continue;
    }
    if (arg === "--profile-dir" && next) {
      options.profileDir = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--chrome-path" && next) {
      options.chromePath = next;
      i += 1;
      continue;
    }
    if (arg === "--login-url" && next) {
      options.loginUrl = next;
      i += 1;
      continue;
    }
    if (arg === "--keep-profile") {
      options.keepProfile = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds");
  }
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds <= 0) {
    throw new Error("--poll must be a positive number of seconds");
  }

  return options;
}

function printHelp() {
  console.log(`Manual Proton login + SweetLink cookie export\n
Usage:
  pnpm run bootstrap:cookies -- [options]

Options:
  --timeout <seconds>     Max wait time for login detection (default: 600)
  --poll <seconds>        Poll interval for login detection (default: 3)
  --output <path>         Export file path (default: secrets/proton-cookies.json)
  --profile-dir <path>    Reuse an existing Chrome profile directory
  --keep-profile          Keep temp profile directory after export
  --chrome-path <path>    Chrome executable path
  --login-url <url>       URL to open for login (default: https://calendar.proton.me/u/0)
`);
}

function defaultChromePath() {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  return "/usr/bin/google-chrome";
}

function launchChrome(chromePath, profileDir, devtoolsPort, loginUrl) {
  const args = [
    `--remote-debugging-port=${devtoolsPort}`,
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-insecure-localhost",
    loginUrl,
  ];

  const child = spawn(chromePath, args, {
    stdio: "ignore",
    detached: process.platform !== "win32",
  });

  child.unref();
  return child;
}

async function exportCookiesWithSweetLink(profileDir, domains) {
  const args = ["exec", "sweetlink", "cookies", ...domains, "--json"];
  const chromeProfilePath = await resolveSweetLinkProfilePath(profileDir);
  const env = {
    ...process.env,
    SWEETLINK_CHROME_PROFILE_PATH: chromeProfilePath,
  };

  const result = await runCommand("pnpm", args, env, { timeoutMs: 15000 });
  const parsed = JSON.parse(result.stdout || "{}");
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function resolveSweetLinkProfilePath(profileDir) {
  const defaultProfile = path.join(profileDir, "Default");
  const defaultCookiesDb = path.join(defaultProfile, "Cookies");
  if (await fileExists(defaultCookiesDb)) {
    return defaultProfile;
  }
  return profileDir;
}

async function assertSweetLinkInstalled() {
  await runCommand("pnpm", ["exec", "sweetlink", "--version"], process.env).catch((err) => {
    throw new Error(`SweetLink is required. Run \`pnpm install\` first.\n${err.message}`);
  });
}

function runCommand(command, args, env, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`));
    });
  });
}

async function shutdownChrome(child) {
  if (!child || typeof child.pid !== "number") {
    return;
  }

  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    return;
  }

  await delay(1200);
  try {
    process.kill(child.pid, 0);
    process.kill(child.pid, "SIGKILL");
  } catch {
    // already stopped
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
