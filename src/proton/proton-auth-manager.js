import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_COOLDOWN_MS = 300000;
const DEFAULT_LOCK_POLL_MS = 1000;
const DEFAULT_STALE_LOCK_GRACE_MS = 30000;

export class ProtonAuthManager {
  constructor(options = {}) {
    this.sessionStore = options.sessionStore;
    this.enabled = Boolean(options.enabled);
    this.mode = normalizeMode(options.mode);
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.pollSeconds = options.pollSeconds || 3;
    this.chromePath = options.chromePath || "";
    this.profileDir = options.profileDir || "";
    this.loginUrl = options.loginUrl || "https://calendar.proton.me/u/0";
    this.nodePath = options.nodePath || process.execPath;
    this.bootstrapScriptPath =
      options.bootstrapScriptPath || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/bootstrap-proton-cookies.mjs");
    this.bootstrapRunner = options.bootstrapRunner || ((runOptions) => runBootstrapScript(this.nodePath, this.bootstrapScriptPath, runOptions));
    this.debugAuth = Boolean(options.debugAuth);
    this.cooldownMs = readNonNegativeNumber(options.cooldownMs, DEFAULT_COOLDOWN_MS);
    this.lockPollMs = readPositiveNumber(options.lockPollMs, DEFAULT_LOCK_POLL_MS);
    this.now = options.now || (() => Date.now());
    this.recoveryLockPath = resolveRecoveryLockPath(options.recoveryLockPath, this.sessionStore);
    this.recoveryStatePath = resolveRecoveryStatePath(options.recoveryStatePath, this.sessionStore);
    this.inFlightRecovery = null;
  }

  async recover(options = {}) {
    if (!this.enabled || !this.sessionStore) {
      return false;
    }

    if (this.inFlightRecovery) {
      return this.inFlightRecovery;
    }

    const recovery = this.#recoverWithGuards(options).finally(() => {
      if (this.inFlightRecovery === recovery) {
        this.inFlightRecovery = null;
      }
    });

    this.inFlightRecovery = recovery;
    return recovery;
  }

  async #recoverWithGuards(options) {
    const cooldown = await this.#readCooldownState();
    if (cooldown.active) {
      this.#authLog("Skipping relogin during cooldown window", {
        remainingMs: cooldown.remainingMs,
        reason: options.reason || null,
      });
      return false;
    }

    const lock = await acquireRecoveryLock({
      lockPath: this.recoveryLockPath,
      timeoutMs: this.timeoutMs,
      pollMs: this.lockPollMs,
      staleMs: Math.max(this.timeoutMs + DEFAULT_STALE_LOCK_GRACE_MS, 60000),
      now: this.now,
    });

    if (!lock.acquired) {
      if (!lock.released) {
        this.#authLog("Timed out waiting for relogin lock", {
          lockPath: this.recoveryLockPath,
        });
        return false;
      }

      const postWaitCooldown = await this.#readCooldownState();
      if (postWaitCooldown.active) {
        this.#authLog("External relogin ended in cooldown", {
          remainingMs: postWaitCooldown.remainingMs,
          lockPath: this.recoveryLockPath,
        });
        return false;
      }

      if (typeof this.sessionStore.invalidate === "function") {
        await this.sessionStore.invalidate();
      }

      this.#authLog("Observed external relogin completion", {
        lockPath: this.recoveryLockPath,
      });
      return true;
    }

    try {
      const recovered = await this.#recoverOnce(options);
      if (recovered) {
        await clearCooldownState(this.recoveryStatePath);
      } else {
        await writeCooldownState(this.recoveryStatePath, this.now());
      }
      return recovered;
    } finally {
      await lock.release();
    }
  }

  async #recoverOnce(options) {
    const attempts = buildAttempts(this.mode);

    for (const attempt of attempts) {
      this.#authLog("Starting relogin attempt", { mode: attempt.mode, reason: options.reason || null });

      try {
        await this.bootstrapRunner({
          outputFile: this.sessionStore.getBundlePath(),
          timeoutSeconds: Math.max(1, Math.ceil(this.timeoutMs / 1000)),
          pollSeconds: this.pollSeconds,
          chromePath: this.chromePath,
          profileDir: this.profileDir,
          loginUrl: this.loginUrl,
          keepProfile: Boolean(this.profileDir),
          headless: attempt.headless,
        });

        if (typeof this.sessionStore.invalidate === "function") {
          await this.sessionStore.invalidate();
        }

        this.#authLog("Relogin attempt succeeded", { mode: attempt.mode });
        return true;
      } catch (error) {
        this.#authLog("Relogin attempt failed", {
          mode: attempt.mode,
          message: error?.message,
        });
      }
    }

    return false;
  }

  async #readCooldownState() {
    if (this.cooldownMs <= 0) {
      return { active: false, remainingMs: 0 };
    }

    const lastFailureAt = await readCooldownTimestamp(this.recoveryStatePath);
    if (!Number.isFinite(lastFailureAt)) {
      return { active: false, remainingMs: 0 };
    }

    const remainingMs = Math.max(0, lastFailureAt + this.cooldownMs - this.now());
    return {
      active: remainingMs > 0,
      remainingMs,
    };
  }

  #authLog(message, details = undefined) {
    if (!this.debugAuth) {
      return;
    }

    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    console.log(`[proton-auth] ${message}${suffix}`);
  }
}

function normalizeMode(value) {
  const mode = String(value || "disabled").trim().toLowerCase();
  if (["disabled", "headless", "headful", "hybrid"].includes(mode)) {
    return mode;
  }
  return "disabled";
}

function buildAttempts(mode) {
  if (mode === "headless") {
    return [{ mode, headless: true }];
  }
  if (mode === "headful") {
    return [{ mode, headless: false }];
  }
  if (mode === "hybrid") {
    return [
      { mode: "headless", headless: true },
      { mode: "headful", headless: false },
    ];
  }
  return [];
}

function resolveRecoveryLockPath(explicitPath, sessionStore) {
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath.trim());
  }

  if (sessionStore && typeof sessionStore.getBundlePath === "function") {
    return `${sessionStore.getBundlePath()}.relogin.lock`;
  }

  return null;
}

function resolveRecoveryStatePath(explicitPath, sessionStore) {
  if (typeof explicitPath === "string" && explicitPath.trim().length > 0) {
    return path.resolve(explicitPath.trim());
  }

  if (sessionStore && typeof sessionStore.getBundlePath === "function") {
    return `${sessionStore.getBundlePath()}.relogin-state.json`;
  }

  return null;
}

function readPositiveNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function readNonNegativeNumber(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0) {
    return num;
  }
  return fallback;
}

async function acquireRecoveryLock({ lockPath, timeoutMs, pollMs, staleMs, now }) {
  if (!lockPath) {
    return {
      acquired: true,
      release: async () => {},
    };
  }

  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now(), timeoutMs })}\n`);
      } finally {
        await handle.close();
      }

      return {
        acquired: true,
        release: async () => {
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (await isRecoveryLockStale(lockPath, staleMs, now)) {
        await rm(lockPath, { force: true });
        continue;
      }

      return {
        acquired: false,
        released: await waitForLockRelease(lockPath, timeoutMs, pollMs),
      };
    }
  }
}

async function waitForLockRelease(lockPath, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fileExists(lockPath))) {
      return true;
    }
    await delay(pollMs);
  }
  return !(await fileExists(lockPath));
}

async function readLockStartedAt(lockPath) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const startedAt = Number(parsed?.startedAt);
    return Number.isFinite(startedAt) ? startedAt : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

async function isRecoveryLockStale(lockPath, staleMs, now) {
  const currentTime = now();
  const startedAt = await readLockStartedAt(lockPath);
  if (Number.isFinite(startedAt)) {
    return currentTime - startedAt > staleMs;
  }

  try {
    const fileStat = await stat(lockPath);
    return currentTime - fileStat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function readCooldownTimestamp(statePath) {
  if (!statePath) {
    return Number.NaN;
  }

  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const lastFailureAt = Number(parsed?.lastFailureAt);
    return Number.isFinite(lastFailureAt) ? lastFailureAt : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

async function writeCooldownState(statePath, lastFailureAt) {
  if (!statePath) {
    return;
  }

  await mkdir(path.dirname(statePath), { recursive: true });
  const handle = await open(statePath, "w");
  try {
    await handle.writeFile(`${JSON.stringify({ lastFailureAt })}\n`);
  } finally {
    await handle.close();
  }
}

async function clearCooldownState(statePath) {
  if (!statePath) {
    return;
  }
  await rm(statePath, { force: true });
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runBootstrapScript(nodePath, scriptPath, options) {
  const args = [scriptPath, "--output", options.outputFile, "--timeout", String(options.timeoutSeconds), "--poll", String(options.pollSeconds)];

  if (options.chromePath) {
    args.push("--chrome-path", options.chromePath);
  }
  if (options.profileDir) {
    args.push("--profile-dir", options.profileDir);
  }
  if (options.loginUrl) {
    args.push("--login-url", options.loginUrl);
  }
  if (options.keepProfile) {
    args.push("--keep-profile");
  }
  if (options.headless) {
    args.push("--headless");
  }

  await new Promise((resolve, reject) => {
    const child = spawn(nodePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `bootstrap exited with code ${code}`));
    });
  });
}
