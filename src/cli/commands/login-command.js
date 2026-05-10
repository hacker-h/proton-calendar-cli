import { randomBytes } from "node:crypto";
import path from "node:path";
import { CookieSessionStore } from "../../session/cookie-session-store.js";
import { normalizeOutput, requireValue } from "../args.js";
import { buildProtonHosts, fetchCalendarsForLogin, findWorkingUid, readCookieBundle, readUidCandidates, runBootstrapScript, selectLoginCalendarConfig } from "../auth-helpers.js";
import { DEFAULT_API_BASE_URL, DEFAULT_COOKIE_BUNDLE_PATH, DEFAULT_LOCAL_CONFIG_PATH, DEFAULT_PROTON_BASE_URL, DEFAULT_SERVER_ENV_PATH } from "../constants.js";
import { CliError } from "../errors.js";
import { writeJson, writeServerEnv } from "../server-env.js";

export async function runLoginCommand(args, context) {
  const parsed = parseLoginArgs(args, context.env);

  const bootstrapRunner = context.bootstrapRunner || runBootstrapScript;
  await bootstrapRunner(parsed.bootstrapArgs);

  const sessionStore = new CookieSessionStore({
    cookieBundlePath: parsed.cookieBundlePath,
  });

  const bundle = await readCookieBundle(parsed.cookieBundlePath);
  const uidCandidates = readUidCandidates(bundle);
  if (uidCandidates.length === 0) {
    throw new CliError(
      "LOGIN_FAILED",
      "Cookie bundle does not include uidCandidates. Please complete full Proton login during pc login."
    );
  }

  const protonHosts = buildProtonHosts(parsed.protonBaseUrl);
  const { uid } = await findWorkingUid({
    fetchImpl: context.fetchImpl,
    protonHosts,
    sessionStore,
    bundle,
    uidCandidates,
  });

  const calendarsPayload = await fetchCalendarsForLogin({
    fetchImpl: context.fetchImpl,
    protonHosts,
    sessionStore,
    bundle,
    uid,
  });

  const calendars = Array.isArray(calendarsPayload?.Calendars) ? calendarsPayload.Calendars : [];
  const calendarConfig = selectLoginCalendarConfig(calendars, {
    targetCalendarId: parsed.targetCalendarId,
    defaultCalendarId: parsed.defaultCalendarId,
  });

  const generateToken = context.generateToken || (() => randomBytes(24).toString("base64url"));
  const apiToken = String(generateToken());
  if (!apiToken) {
    throw new CliError("LOGIN_FAILED", "Unable to generate API token");
  }

  await writeJson(parsed.pcConfigPath, {
    apiBaseUrl: parsed.apiBaseUrl,
    apiToken,
  });

  await writeServerEnv(parsed.serverEnvPath, {
    apiToken,
    ...calendarConfig,
    cookieBundlePath: parsed.cookieBundlePath,
    protonBaseUrl: parsed.protonBaseUrl,
    apiBaseUrl: parsed.apiBaseUrl,
  });

  return {
    output: parsed.output,
    payload: {
      data: {
        login: "ok",
        uid,
        targetCalendarId: calendarConfig.targetCalendarId,
        defaultCalendarId: calendarConfig.defaultCalendarId,
        allowedCalendarIds: calendarConfig.allowedCalendarIds,
        cookieBundlePath: parsed.cookieBundlePath,
        pcConfigPath: parsed.pcConfigPath,
        serverEnvPath: parsed.serverEnvPath,
        nextSteps: [
          `source ${parsed.serverEnvPath}`,
          "pnpm start",
          "open another shell and run: pc ls",
        ],
      },
    },
  };
}


function parseLoginArgs(args, env) {
  const state = {
    output: "json",
    cookieBundlePath: path.resolve(DEFAULT_COOKIE_BUNDLE_PATH),
    pcConfigPath: path.resolve(env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH),
    serverEnvPath: path.resolve(env.PC_SERVER_ENV_PATH || DEFAULT_SERVER_ENV_PATH),
    apiBaseUrl: env.PC_API_BASE_URL || DEFAULT_API_BASE_URL,
    protonBaseUrl: env.PROTON_BASE_URL || DEFAULT_PROTON_BASE_URL,
    targetCalendarId: null,
    defaultCalendarId: null,
    timeout: null,
    poll: null,
    profileDir: null,
    chromePath: null,
    loginUrl: null,
    keepProfile: false,
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
    if (token === "--api-base-url") {
      state.apiBaseUrl = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--proton-base-url") {
      state.protonBaseUrl = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--target-calendar") {
      state.targetCalendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--default-calendar") {
      state.defaultCalendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--timeout") {
      state.timeout = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--poll") {
      state.poll = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--profile-dir") {
      state.profileDir = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--chrome-path") {
      state.chromePath = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--login-url") {
      state.loginUrl = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--keep-profile") {
      state.keepProfile = true;
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown login option: ${token}`);
  }

  if (state.targetCalendarId && state.defaultCalendarId) {
    throw new CliError("INVALID_ARGS", "Use either --target-calendar or --default-calendar, not both");
  }

  const bootstrapArgs = [];
  bootstrapArgs.push("--output", state.cookieBundlePath);
  if (state.timeout !== null) {
    bootstrapArgs.push("--timeout", String(state.timeout));
  }
  if (state.poll !== null) {
    bootstrapArgs.push("--poll", String(state.poll));
  }
  if (state.profileDir) {
    bootstrapArgs.push("--profile-dir", state.profileDir);
  }
  if (state.chromePath) {
    bootstrapArgs.push("--chrome-path", state.chromePath);
  }
  if (state.loginUrl) {
    bootstrapArgs.push("--login-url", state.loginUrl);
  }
  if (state.keepProfile) {
    bootstrapArgs.push("--keep-profile");
  }

  return {
    output: normalizeOutput(state.output),
    cookieBundlePath: state.cookieBundlePath,
    pcConfigPath: state.pcConfigPath,
    serverEnvPath: state.serverEnvPath,
    apiBaseUrl: state.apiBaseUrl,
    protonBaseUrl: state.protonBaseUrl,
    targetCalendarId: state.targetCalendarId,
    defaultCalendarId: state.defaultCalendarId,
    bootstrapArgs,
  };
}


