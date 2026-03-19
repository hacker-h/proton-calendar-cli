import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120000;

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
    this.inFlightRecovery = null;
  }

  async recover(options = {}) {
    if (!this.enabled || !this.sessionStore) {
      return false;
    }

    if (this.inFlightRecovery) {
      return this.inFlightRecovery;
    }

    const recovery = this.#recoverOnce(options).finally(() => {
      if (this.inFlightRecovery === recovery) {
        this.inFlightRecovery = null;
      }
    });

    this.inFlightRecovery = recovery;
    return recovery;
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

  #authLog(message, details = undefined) {
    if (!this.debugAuth) {
      return;
    }

    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    // eslint-disable-next-line no-console
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
