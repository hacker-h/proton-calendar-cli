import { unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeOutput, requireValue } from "../args.js";
import { DEFAULT_COOKIE_BUNDLE_PATH, DEFAULT_LOCAL_CONFIG_PATH, DEFAULT_SERVER_ENV_PATH } from "../constants.js";
import { CliError } from "../errors.js";

export async function runLogoutCommand(args, context) {
  const parsed = parseLogoutArgs(args, context.env);
  const targets = [
    { kind: "cliConfig", path: parsed.pcConfigPath },
    { kind: "serverEnv", path: parsed.serverEnvPath },
    { kind: "cookieBundle", path: parsed.cookieBundlePath },
    { kind: "reloginLock", path: `${parsed.cookieBundlePath}.relogin.lock` },
    { kind: "reloginState", path: `${parsed.cookieBundlePath}.relogin-state.json` },
  ];

  const removed = [];
  const missing = [];
  const failed = [];

  for (const target of targets) {
    try {
      await unlink(target.path);
      removed.push(target);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missing.push(target);
        continue;
      }
      failed.push({ ...target, code: error?.code || "UNLINK_FAILED", message: error?.message || "Unable to remove file" });
    }
  }

  return {
    output: parsed.output,
    payload: {
      data: {
        logout: failed.length === 0 ? "ok" : "partial",
        removed,
        missing,
        failed,
      },
    },
  };
}


function parseLogoutArgs(args, env) {
  const state = {
    output: "json",
    cookieBundlePath: path.resolve(env.COOKIE_BUNDLE_PATH || DEFAULT_COOKIE_BUNDLE_PATH),
    pcConfigPath: path.resolve(env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH),
    serverEnvPath: path.resolve(env.PC_SERVER_ENV_PATH || DEFAULT_SERVER_ENV_PATH),
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];

    if (token === "-o" || token === "--output") {
      state.output = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--cookie-bundle") {
      state.cookieBundlePath = path.resolve(requireValue(args, ++i, token));
      continue;
    }
    if (token === "--pc-config") {
      state.pcConfigPath = path.resolve(requireValue(args, ++i, token));
      continue;
    }
    if (token === "--server-env") {
      state.serverEnvPath = path.resolve(requireValue(args, ++i, token));
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown logout option: ${token}`);
  }

  return {
    output: normalizeOutput(state.output),
    cookieBundlePath: state.cookieBundlePath,
    pcConfigPath: state.pcConfigPath,
    serverEnvPath: state.serverEnvPath,
  };
}


