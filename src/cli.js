#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROTON_APP_VERSION } from "./constants.js";
import { assertSafeSecretFile, chmodOwnerOnly } from "./secret-file-safety.js";
import { CookieSessionStore } from "./session/cookie-session-store.js";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_LOCAL_CONFIG_PATH = "secrets/pc-cli.json";
const DEFAULT_SERVER_ENV_PATH = "secrets/pc-server.env";
const DEFAULT_COOKIE_BUNDLE_PATH = "secrets/proton-cookies.json";
const DEFAULT_PROTON_BASE_URL = "https://calendar.proton.me";
const DEFAULT_TIMEOUT_MS = 15000;
const CLEARABLE_FIELDS = new Set(["description", "location"]);
const VALID_TIMEZONES = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

const HELP_TEXT = `pc - Proton Calendar CLI

Usage:
  pc login [options]
  pc logout [options]
  pc doctor auth [options]
  pc calendars [options]
  pc ls [w|w+|w++|m|y|all] [--protected|--unprotected] [--title TEXT] [--description TEXT] [--location TEXT] [args]
  pc new <field=value...> [--tz TIMEZONE]
  pc edit <eventId> <field=value...> [--tz TIMEZONE] [--clear FIELD]
  pc rm <eventId>

Examples:
  pc login
  pc logout
  pc doctor auth
  pc calendars
  pc ls
  pc ls w+
  pc ls m 7 2026
  pc ls --from 2026-07-01 --to 2026-07-31
  pc ls --protected
  pc ls --unprotected
  pc ls --title review
  pc ls --description workshop
  pc ls --location "room a"
  pc new title="Design review" start=2026-03-10T10:00:00Z end=2026-03-10T10:30:00Z timezone=UTC
  pc edit evt-1 title="Updated" --clear description
  pc edit evt-1 --scope single --at 2026-03-12T09:00:00Z location="Room B"
  pc rm evt-1 --scope series

Environment:
  PC_API_BASE_URL     API base URL (default: http://127.0.0.1:8787)
  PC_API_TOKEN        Bearer token for API requests
  API_BEARER_TOKEN    Fallback token env var
  PC_CONFIG_PATH      Optional path to local CLI config JSON
  PC_SERVER_ENV_PATH  Optional path to generated server env file

Login options:
  --target-calendar <id>  Use specific calendar ID (default: first available)
  --default-calendar <id> Use specific default calendar while allowing all discovered calendars
  --timeout <seconds>     Bootstrap login timeout (forwarded)
  --poll <seconds>        Bootstrap polling interval (forwarded)
  --profile-dir <path>    Chrome profile directory (forwarded)
  --chrome-path <path>    Chrome executable path (forwarded)
  --cookie-bundle <path>  Cookie bundle output path

Logout options:
  --cookie-bundle <path>  Cookie bundle path to remove
  --pc-config <path>      Local CLI config path to remove
  --server-env <path>     Server env path to remove

Doctor options:
  --cookie-bundle <path>  Cookie bundle path to inspect
  --proton-base-url <url> Proton base URL to probe
  --fail-on-relogin-required  Exit non-zero when browser login is required

Calendars options:
  --set-default <id> Set the default calendar in the generated server env file
  --server-env <path> Server env file to update when setting default

List options:
  --protected         Show only protected events
  --unprotected       Show only unprotected events
  --title <text>       Show only events whose title contains text (case-insensitive)
  --description <text> Show only events whose description contains text (case-insensitive)
  --location <text>    Show only events whose location contains text (case-insensitive)

Local config JSON (default: secrets/pc-cli.json):
  { "apiBaseUrl": "http://127.0.0.1:8787", "apiToken": "replace-me" }
`;

class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

export async function runPcCli(argv, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  try {
    const normalizedArgs = Array.isArray(argv) ? [...argv] : [];
    while (normalizedArgs[0] === "--") {
      normalizedArgs.shift();
    }

    const [rawCommand, ...rest] = normalizedArgs;
    const command = rawCommand || "help";

    if (["help", "--help", "-h"].includes(command)) {
      write(stdout, HELP_TEXT);
      return 0;
    }

    if (command === "login" || command === "authorize") {
      const result = await runLoginCommand(rest, {
        env,
        fetchImpl,
        stdout,
        bootstrapRunner: options.bootstrapRunner,
        generateToken: options.generateToken,
      });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (command === "logout") {
      const result = await runLogoutCommand(rest, { env });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (command === "doctor") {
      const result = await runDoctorCommand(rest, {
        env,
        fetchImpl,
      });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    const apiCommand = normalizeApiCommand(command);
    if (!apiCommand) {
      throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
    }

    const localConfig = await readLocalConfig(env);
    const apiBaseUrl = readBaseUrl(env, localConfig);
    const apiToken = readToken(env, localConfig);

    if (apiCommand === "list") {
      const result = await runListCommand(rest, { apiBaseUrl, apiToken, fetchImpl, now });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "calendars") {
      const result = await runCalendarsCommand(rest, { env, apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "create") {
      const result = await runCreateCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "edit") {
      const result = await runEditCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "delete") {
      const result = await runDeleteCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }
  } catch (error) {
    const payload = toCliErrorPayload(error);
    write(stderr, `${JSON.stringify(payload, null, 2)}\n`);
    return 1;
  }
}

function normalizeApiCommand(command) {
  if (command === "ls" || command === "list") {
    return "list";
  }
  if (command === "new" || command === "create") {
    return "create";
  }
  if (command === "edit") {
    return "edit";
  }
  if (command === "rm" || command === "delete") {
    return "delete";
  }
  if (command === "calendars") {
    return "calendars";
  }
  return null;
}

async function runLoginCommand(args, context) {
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

async function runDoctorCommand(args, context) {
  const parsed = parseDoctorArgs(args, context.env);
  if (parsed.topic !== "auth") {
    throw new CliError("INVALID_ARGS", `Unknown doctor topic: ${parsed.topic}`);
  }

  const sessionStore = new CookieSessionStore({
    cookieBundlePath: parsed.cookieBundlePath,
  });

  const bundle = await readCookieBundle(parsed.cookieBundlePath);
  const uidCandidates = readUidCandidates(bundle);
  const protonHosts = buildProtonHosts(parsed.protonBaseUrl);

  const before = await readAuthDiagnostics(sessionStore);
  let refreshPossible = false;
  for (const uid of uidCandidates) {
    const payload = await extractRefreshPayload(sessionStore, bundle, uid);
    if (payload) {
      refreshPossible = true;
      break;
    }
  }

  const probeBefore = await probeWorkingUid({
    fetchImpl: context.fetchImpl,
    protonHosts,
    sessionStore,
    bundle,
    uidCandidates,
  });

  let refreshAttempted = false;
  let refreshSucceeded = false;
  let probeAfter = probeBefore;

  if (!probeBefore) {
    if (refreshPossible) {
      for (const uid of uidCandidates) {
        refreshAttempted = true;
        const refreshed = await attemptLoginRefresh({
          fetchImpl: context.fetchImpl,
          protonHosts,
          sessionStore,
          bundle,
          uid,
        });
        if (!refreshed) {
          continue;
        }

        refreshSucceeded = true;
        probeAfter = await probeWorkingUid({
          fetchImpl: context.fetchImpl,
          protonHosts,
          sessionStore,
          bundle,
          uidCandidates,
        });
        if (probeAfter) {
          break;
        }
      }
    }
  }

  const after = await readAuthDiagnostics(sessionStore);
  const reloginRequired = !probeAfter;
  const status = probeBefore
    ? "access_valid"
    : probeAfter
      ? "refresh_recovered"
      : refreshAttempted
        ? "refresh_failed"
        : "refresh_unavailable";
  const nextStep = readDoctorAuthNextStep({ status, reloginRequired, refreshPossible });
  const data = {
    topic: "auth",
    status,
    automationReady: !reloginRequired,
    reloginRequired,
    refreshPossible,
    refreshAttempted,
    refreshSucceeded,
    nextStep,
    uid: probeAfter?.uid || null,
    host: probeAfter?.protonBaseUrl || null,
    uidCandidates,
    protonHosts,
    cookieBundlePath: parsed.cookieBundlePath,
    authCookies: {
      before,
      after,
    },
    suggestions: [nextStep.message],
  };

  if (parsed.failOnReloginRequired && reloginRequired) {
    throw new CliError("AUTH_RELOGIN_REQUIRED", nextStep.message, data);
  }

  return {
    output: parsed.output,
    payload: {
      data,
    },
  };
}

async function runCalendarsCommand(args, context) {
  const parsed = parseCalendarsArgs(args, context.env);
  const payload = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "GET",
    path: "/v1/calendars",
  });

  if (!parsed.defaultCalendarId) {
    return {
      output: parsed.output,
      payload,
    };
  }

  const calendars = Array.isArray(payload?.data?.calendars) ? payload.data.calendars : [];
  const allowedCalendarIds = calendars.map((calendar) => String(calendar?.id || "")).filter(Boolean);
  if (!allowedCalendarIds.includes(parsed.defaultCalendarId)) {
    throw new CliError("INVALID_ARGS", `Requested calendar not found: ${parsed.defaultCalendarId}`);
  }
  if (payload?.data?.targetCalendarId) {
    throw new CliError(
      "INVALID_ARGS",
      "Cannot set a default calendar while TARGET_CALENDAR_ID hard-lock mode is active. Re-run pc login --default-calendar to switch modes."
    );
  }

  await updateServerEnvCalendarConfig(parsed.serverEnvPath, {
    apiToken: context.apiToken,
    apiBaseUrl: context.apiBaseUrl,
    defaultCalendarId: parsed.defaultCalendarId,
    allowedCalendarIds,
    env: context.env,
  });

  const nextPayload = {
    ...payload,
    data: {
      ...payload.data,
      defaultCalendarId: parsed.defaultCalendarId,
      allowedCalendarIds,
      calendars: calendars.map((calendar) => ({
        ...calendar,
        default: calendar.id === parsed.defaultCalendarId,
      })),
      serverEnvPath: parsed.serverEnvPath,
    },
  };

  return {
    output: parsed.output,
    payload: nextPayload,
  };
}

function readDoctorAuthNextStep({ status, reloginRequired, refreshPossible }) {
  if (!reloginRequired) {
    return {
      code: "proceed",
      message: "Auth is ready for unattended calendar operations.",
    };
  }

  if (status === "refresh_failed") {
    return {
      code: "rerun_login_after_failed_refresh",
      message: "Refresh cookies were present but could not recover the session; run `pc login` interactively.",
    };
  }

  if (!refreshPossible) {
    return {
      code: "rerun_login_no_refresh_cookie",
      message: "No usable refresh cookie was found; run `pc login` interactively.",
    };
  }

  return {
    code: "rerun_login",
    message: "Run `pc login` and complete browser sign-in.",
  };
}

async function runLogoutCommand(args, context) {
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

function parseDoctorArgs(args, env) {
  const state = {
    output: "json",
    topic: "auth",
    cookieBundlePath: path.resolve(DEFAULT_COOKIE_BUNDLE_PATH),
    protonBaseUrl: env.PROTON_BASE_URL || DEFAULT_PROTON_BASE_URL,
    failOnReloginRequired: false,
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
    if (token === "--proton-base-url") {
      state.protonBaseUrl = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--fail-on-relogin-required") {
      state.failOnReloginRequired = true;
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError("INVALID_ARGS", `Unknown doctor option: ${token}`);
    }
    state.topic = token;
  }

  return {
    output: normalizeOutput(state.output),
    topic: state.topic,
    cookieBundlePath: state.cookieBundlePath,
    protonBaseUrl: state.protonBaseUrl,
    failOnReloginRequired: state.failOnReloginRequired,
  };
}

async function probeWorkingUid(input) {
  for (const uid of input.uidCandidates) {
    for (const protonBaseUrl of input.protonHosts) {
      try {
        await requestProtonJson(input.fetchImpl, {
          protonBaseUrl,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
          method: "GET",
          pathname: "/api/calendar/v1",
        });
        return {
          uid,
          protonBaseUrl,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function readAuthDiagnostics(sessionStore) {
  if (typeof sessionStore.getAuthCookieDiagnostics !== "function") {
    return [];
  }

  const rows = await sessionStore.getAuthCookieDiagnostics();
  return rows.map((row) => ({
    ...row,
    expiresAtIso:
      typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt)
        ? new Date(row.expiresAt).toISOString()
        : null,
  }));
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

function parseCalendarsArgs(args, env) {
  const state = {
    output: "json",
    defaultCalendarId: null,
    serverEnvPath: path.resolve(env.PC_SERVER_ENV_PATH || DEFAULT_SERVER_ENV_PATH),
  };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-o" || token === "--output") {
      state.output = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--set-default") {
      state.defaultCalendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--server-env") {
      state.serverEnvPath = path.resolve(requireValue(args, ++i, token));
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown calendars option: ${token}`);
  }
  return {
    output: normalizeOutput(state.output),
    defaultCalendarId: state.defaultCalendarId,
    serverEnvPath: state.serverEnvPath,
  };
}

async function runBootstrapScript(bootstrapArgs) {
  const cliPath = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(cliPath), "..");
  const scriptPath = path.join(projectRoot, "scripts", "bootstrap-proton-cookies.mjs");

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...bootstrapArgs], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new CliError("LOGIN_FAILED", `Cookie bootstrap failed with exit code ${code}`));
    });
  });
}

async function readCookieBundle(cookieBundlePath) {
  try {
    await assertSafeSecretFile(cookieBundlePath, {
      createError: (message, details) => new CliError("SECRET_FILE_UNSAFE_PERMISSIONS", message, details),
    });
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("LOGIN_FAILED", `Cookie bundle file not found: ${cookieBundlePath}`);
  }

  let content;
  try {
    content = await readFile(cookieBundlePath, "utf8");
  } catch {
    throw new CliError("LOGIN_FAILED", `Cookie bundle file not found: ${cookieBundlePath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError("LOGIN_FAILED", `Cookie bundle is not valid JSON: ${cookieBundlePath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("LOGIN_FAILED", `Cookie bundle must be a JSON object: ${cookieBundlePath}`);
  }

  return parsed;
}

function readUidCandidates(bundle) {
  const candidates = Array.isArray(bundle?.uidCandidates) ? bundle.uidCandidates : [];
  return candidates.filter((value) => typeof value === "string" && value.length > 0);
}

async function findWorkingUid(input) {
  for (const uid of input.uidCandidates) {
    for (const protonBaseUrl of input.protonHosts) {
      try {
        await requestProtonJson(input.fetchImpl, {
          protonBaseUrl,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
          method: "GET",
          pathname: "/api/calendar/v1",
        });
        return { uid, protonBaseUrl };
      } catch (error) {
        const refreshed = await attemptLoginRefresh({
          fetchImpl: input.fetchImpl,
          protonHosts: input.protonHosts,
          sessionStore: input.sessionStore,
          bundle: input.bundle,
          uid,
        });

        if (!refreshed) {
          if (error instanceof CliError && error.code === "AUTH_EXPIRED") {
            continue;
          }
          continue;
        }

        try {
          await requestProtonJson(input.fetchImpl, {
            protonBaseUrl,
            sessionStore: input.sessionStore,
            bundle: input.bundle,
            uid,
            method: "GET",
            pathname: "/api/calendar/v1",
          });
          return { uid, protonBaseUrl };
        } catch {
          continue;
        }
      }
    }
  }

  throw new CliError(
    "AUTH_EXPIRED",
    "Unable to authenticate with current cookies. Please run pc login again and complete sign-in."
  );
}

async function fetchCalendarsForLogin(input) {
  for (const protonBaseUrl of input.protonHosts) {
    try {
      return await requestProtonJson(input.fetchImpl, {
        protonBaseUrl,
        sessionStore: input.sessionStore,
        bundle: input.bundle,
        uid: input.uid,
        method: "GET",
        pathname: "/api/calendar/v1",
      });
    } catch {
      continue;
    }
  }

  throw new CliError("AUTH_EXPIRED", "Authenticated session is missing calendar scope. Re-run pc login.");
}

async function attemptLoginRefresh(input) {
  const refreshPayload = await extractRefreshPayload(input.sessionStore, input.bundle, input.uid);
  if (!refreshPayload) {
    return false;
  }

  const refreshUrls = [];
  for (const host of input.protonHosts) {
    refreshUrls.push(new URL("/api/auth/v4/refresh", host).toString());
    refreshUrls.push(new URL("/api/auth/refresh", host).toString());
  }

  for (const refreshUrl of [...new Set(refreshUrls)]) {
    const url = new URL(refreshUrl);
    const cookieHeader = await buildLoginCookieHeader(input.sessionStore, url, input.bundle, input.uid);
    if (!cookieHeader) {
      continue;
    }

    let response;
    try {
      response = await input.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.protonmail.v1+json",
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          "x-pm-appversion": DEFAULT_PROTON_APP_VERSION,
          "x-pm-locale": "en-US",
          "x-pm-uid": input.uid,
        },
        body: JSON.stringify(refreshPayload),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch {
      continue;
    }

    await applyLoginSetCookies(input.sessionStore, url, response);

    const payload = parseMaybeJson(await response.text());
    if (!response.ok) {
      continue;
    }
    if (payload && typeof payload === "object" && typeof payload.Code === "number" && ![1000, 1001].includes(payload.Code)) {
      continue;
    }

    return true;
  }

  return false;
}

async function applyLoginSetCookies(sessionStore, url, response) {
  if (typeof sessionStore.applySetCookieHeaders !== "function") {
    return;
  }

  const setCookies = getSetCookieHeaders(response.headers);
  if (setCookies.length === 0) {
    return;
  }

  await sessionStore.applySetCookieHeaders(url.toString(), setCookies);
}

async function extractRefreshPayload(sessionStore, bundle, uid) {
  let sourceBundle = bundle;
  if (typeof sessionStore.getBundle === "function") {
    try {
      sourceBundle = await sessionStore.getBundle();
    } catch {
      // fallback to provided bundle
    }
  }

  const cookies = flattenBundleCookies(sourceBundle);
  const refreshCookies = cookies.filter((cookie) => String(cookie?.name || "").startsWith("REFRESH-"));
  if (refreshCookies.length === 0) {
    return null;
  }

  const selected =
    refreshCookies.find((cookie) => cookie.name === `REFRESH-${uid}`) ||
    refreshCookies.find((cookie) => String(cookie.name).includes(uid)) ||
    refreshCookies[0];

  const rawValue = String(selected?.value || "");
  if (!rawValue) {
    return null;
  }

  let decoded = rawValue;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    // keep raw value
  }

  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return {
    ...parsed,
    UID: typeof parsed.UID === "string" && parsed.UID.length > 0 ? parsed.UID : uid,
    ResponseType: parsed.ResponseType || "token",
    GrantType: parsed.GrantType || "refresh_token",
  };
}

async function buildLoginCookieHeader(sessionStore, url, bundle, uid) {
  const scopedHeader = await sessionStore.getCookieHeader(url.toString());
  const scopedMap = parseCookieHeader(scopedHeader);
  const fallbackMap = new Map();

  let sourceBundle = bundle;
  if (typeof sessionStore.getBundle === "function") {
    try {
      sourceBundle = await sessionStore.getBundle();
    } catch {
      // fallback to provided bundle
    }
  }

  for (const cookie of flattenBundleCookies(sourceBundle)) {
    const name = String(cookie?.name || "");
    if (!name) {
      continue;
    }

    if (name === `AUTH-${uid}` || name === `REFRESH-${uid}` || name === "Session-Id" || name === "Tag" || name === "Domain") {
      fallbackMap.set(name, String(cookie?.value || ""));
    }
  }

  const merged = new Map([...fallbackMap, ...scopedMap]);
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function buildProtonHosts(primary) {
  const hosts = [primary, "https://calendar.proton.me", "https://account.proton.me"];
  const normalized = [];
  const seen = new Set();
  for (const host of hosts) {
    if (!host) {
      continue;
    }
    let url;
    try {
      url = new URL(host);
    } catch {
      continue;
    }
    const key = `${url.protocol}//${url.host}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function selectLoginCalendarConfig(calendars, options) {
  const ids = calendars
    .map((calendar) => (calendar && typeof calendar.ID === "string" ? calendar.ID : ""))
    .filter(Boolean);

  if (options.targetCalendarId) {
    assertKnownCalendarId(ids, options.targetCalendarId);
    return {
      targetCalendarId: options.targetCalendarId,
      defaultCalendarId: null,
      allowedCalendarIds: [],
    };
  }

  if (options.defaultCalendarId) {
    assertKnownCalendarId(ids, options.defaultCalendarId);
    return {
      targetCalendarId: null,
      defaultCalendarId: options.defaultCalendarId,
      allowedCalendarIds: ids,
    };
  }

  if (ids.length === 0) {
    throw new CliError("LOGIN_FAILED", "No calendars found for logged-in account");
  }

  return {
    targetCalendarId: ids[0],
    defaultCalendarId: null,
    allowedCalendarIds: [],
  };
}

function assertKnownCalendarId(ids, calendarId) {
  if (ids.length === 0) {
    throw new CliError("LOGIN_FAILED", "No calendars found for logged-in account");
  }
  if (!ids.includes(calendarId)) {
    throw new CliError("INVALID_ARGS", `Requested calendar not found: ${calendarId}`);
  }
}

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmodOwnerOnly(filePath);
}

async function writeServerEnv(filePath, values) {
  const lines = [
    `export API_BEARER_TOKEN=${quoteEnv(values.apiToken)}`,
    ...buildServerCalendarEnv(values),
    `export COOKIE_BUNDLE_PATH=${quoteEnv(values.cookieBundlePath)}`,
    `export PROTON_BASE_URL=${quoteEnv(values.protonBaseUrl)}`,
    `export PC_API_BASE_URL=${quoteEnv(values.apiBaseUrl)}`,
    `export PC_API_TOKEN=${quoteEnv(values.apiToken)}`,
    "",
    "# Optional unattended auth recovery (leave disabled unless you need runtime relogin):",
    "# export PROTON_AUTO_RELOGIN=\"1\"",
    "# export PROTON_RELOGIN_MODE=\"headless\"",
    "# export PROTON_RELOGIN_TIMEOUT_MS=\"120000\"",
    "# export PROTON_RELOGIN_POLL_SECONDS=\"3\"",
    "# export PROTON_RELOGIN_COOLDOWN_MS=\"300000\"",
    `# export PROTON_RELOGIN_LOCK_PATH=${quoteEnv(`${values.cookieBundlePath}.relogin.lock`)}`,
    "# export PROTON_RELOGIN_URL=\"https://calendar.proton.me/u/0\"",
    "",
  ];

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n"), { mode: 0o600 });
  await chmodOwnerOnly(filePath);
}

async function updateServerEnvCalendarConfig(filePath, values) {
  const existing = await readServerEnvFile(filePath);
  await writeServerEnv(filePath, {
    apiToken: existing.API_BEARER_TOKEN || existing.PC_API_TOKEN || values.apiToken,
    targetCalendarId: null,
    defaultCalendarId: values.defaultCalendarId,
    allowedCalendarIds: values.allowedCalendarIds,
    cookieBundlePath: existing.COOKIE_BUNDLE_PATH || values.env.COOKIE_BUNDLE_PATH || path.resolve(DEFAULT_COOKIE_BUNDLE_PATH),
    protonBaseUrl: existing.PROTON_BASE_URL || values.env.PROTON_BASE_URL || DEFAULT_PROTON_BASE_URL,
    apiBaseUrl: existing.PC_API_BASE_URL || values.apiBaseUrl,
  });
}

async function readServerEnvFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliError("CONFIG_ERROR", `Server env file not found: ${filePath}`);
    }
    throw error;
  }

  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"');
  }
  return value;
}

function buildServerCalendarEnv(values) {
  if (values.targetCalendarId) {
    return [`export TARGET_CALENDAR_ID=${quoteEnv(values.targetCalendarId)}`];
  }

  return [
    `export ALLOWED_CALENDAR_IDS=${quoteEnv(formatCsv(values.allowedCalendarIds || []))}`,
    `export DEFAULT_CALENDAR_ID=${quoteEnv(values.defaultCalendarId || "")}`,
  ];
}

function formatCsv(values) {
  return [...new Set(values)].join(",");
}

function quoteEnv(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function requestProtonJson(fetchImpl, input) {
  const url = new URL(input.pathname, input.protonBaseUrl);
  const cookieHeader = input.bundle
    ? await buildLoginCookieHeader(input.sessionStore, url, input.bundle, input.uid)
    : await input.sessionStore.getCookieHeader(url.toString());
  if (!cookieHeader) {
    throw new CliError("AUTH_EXPIRED", "No valid Proton cookies found");
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: input.method,
      headers: {
        Accept: "application/vnd.protonmail.v1+json",
        Cookie: cookieHeader,
        "x-pm-appversion": DEFAULT_PROTON_APP_VERSION,
        "x-pm-locale": "en-US",
        "x-pm-uid": input.uid,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError("LOGIN_FAILED", "Unable to reach Proton API", {
      message: error?.message,
    });
  }

  const text = await response.text();
  const payload = parseMaybeJson(text);

  if (response.status === 401 || response.status === 403) {
    throw new CliError("AUTH_EXPIRED", "Proton session is unauthorized or expired");
  }

  if (!response.ok) {
    throw new CliError("LOGIN_FAILED", "Proton request failed", {
      status: response.status,
      ...sanitizeUpstreamPayload(payload),
    });
  }

  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    if (![1000, 1001].includes(payload.Code)) {
      throw new CliError("LOGIN_FAILED", "Unexpected Proton response", sanitizeUpstreamPayload(payload));
    }
  }

  return payload;
}

function getSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) {
      return values.filter((value) => typeof value === "string" && value.length > 0);
    }
  }

  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }
  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(raw) {
  const rows = [];
  let cursor = "";
  let inExpires = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];
    cursor += char;

    if (cursor.toLowerCase().endsWith("expires=")) {
      inExpires = true;
      continue;
    }

    if (inExpires && char === ";") {
      inExpires = false;
      continue;
    }

    if (!inExpires && char === "," && next === " ") {
      const nextFragment = raw.slice(i + 2);
      if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+=/.test(nextFragment)) {
        rows.push(cursor.slice(0, -1).trim());
        cursor = "";
        i += 1;
      }
    }
  }

  if (cursor.trim()) {
    rows.push(cursor.trim());
  }

  return rows;
}

function flattenBundleCookies(bundle) {
  const rows = [];
  if (Array.isArray(bundle?.cookies)) {
    rows.push(...bundle.cookies);
  }

  if (bundle?.cookiesByDomain && typeof bundle.cookiesByDomain === "object") {
    for (const [domain, cookies] of Object.entries(bundle.cookiesByDomain)) {
      if (!Array.isArray(cookies)) {
        continue;
      }
      rows.push(...cookies.map((cookie) => ({ domain, ...cookie })));
    }
  }

  return rows.filter((cookie) => cookie && typeof cookie === "object");
}

function parseCookieHeader(header) {
  const map = new Map();
  if (!header) {
    return map;
  }

  for (const part of String(header).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1);
    if (!name) {
      continue;
    }
    map.set(name, value);
  }

  return map;
}

async function runListCommand(args, context) {
  const parsed = parseListArgs(args, context.now);
  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/events`
    : "/v1/events";

  const events = [];
  let cursor = null;
  let nextCursor = null;
  let pages = 0;

  while (pages < 100) {
    const response = await requestJson(context.fetchImpl, {
      apiBaseUrl: context.apiBaseUrl,
      apiToken: context.apiToken,
      method: "GET",
      path,
      query: {
        start: parsed.range.start,
        end: parsed.range.end,
        limit: String(parsed.pageSize),
        ...(cursor ? { cursor } : {}),
      },
    });

    const rows = Array.isArray(response?.data?.events) ? response.data.events : [];
    events.push(...rows);

    nextCursor = response?.data?.nextCursor || null;
    if (!nextCursor) {
      break;
    }
    if (parsed.maxResults !== null && events.filter((event) => matchesListFilters(event, parsed)).length >= parsed.maxResults) {
      break;
    }

    cursor = nextCursor;
    pages += 1;
  }

  const filteredEvents = events.filter((event) => matchesListFilters(event, parsed));
  const outputEvents = parsed.maxResults === null ? filteredEvents : filteredEvents.slice(0, parsed.maxResults);

  return {
    output: parsed.output,
    payload: {
      data: {
        events: outputEvents,
        count: outputEvents.length,
        range: parsed.range,
        calendarId: parsed.calendarId,
      },
    },
  };
}

async function runCreateCommand(args, context) {
  const parsed = await parseMutationArgs(args, { requireEventId: false });

  if (!parsed.patch.title) {
    throw new CliError("INVALID_ARGS", "title is required (title=...) for pc new");
  }
  if (!parsed.patch.start) {
    throw new CliError("INVALID_ARGS", "start is required (start=<ISO>) for pc new");
  }
  if (!parsed.patch.end) {
    throw new CliError("INVALID_ARGS", "end is required (end=<ISO>) for pc new");
  }
  validateStartBeforeEnd(parsed.patch.start, parsed.patch.end);
  if (!parsed.patch.timezone) {
    parsed.patch.timezone = "UTC";
  }

  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/events`
    : "/v1/events";

  const response = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "POST",
    path,
    body: parsed.patch,
  });

  return {
    output: parsed.output,
    payload: response,
  };
}

async function runEditCommand(args, context) {
  const parsed = await parseMutationArgs(args, { requireEventId: true });
  if (Object.keys(parsed.patch).length === 0) {
    throw new CliError("EMPTY_PATCH", "No fields to update. Provide field=value, --patch, or --clear.");
  }
  if (parsed.patch.start !== undefined && parsed.patch.end !== undefined) {
    validateStartBeforeEnd(parsed.patch.start, parsed.patch.end);
  }

  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/events/${encodeURIComponent(parsed.eventId)}`
    : `/v1/events/${encodeURIComponent(parsed.eventId)}`;

  const response = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "PATCH",
    path,
    query: {
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.occurrenceStart ? { occurrenceStart: parsed.occurrenceStart } : {}),
    },
    body: parsed.patch,
  });

  return {
    output: parsed.output,
    payload: response,
  };
}

async function runDeleteCommand(args, context) {
  const parsed = parseDeleteArgs(args);
  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/events/${encodeURIComponent(parsed.eventId)}`
    : `/v1/events/${encodeURIComponent(parsed.eventId)}`;

  const response = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "DELETE",
    path,
    query: {
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(parsed.occurrenceStart ? { occurrenceStart: parsed.occurrenceStart } : {}),
    },
  });

  return {
    output: parsed.output,
    payload: response,
  };
}

function parseListArgs(args, nowFn) {
  const state = {
    output: "json",
    calendarId: null,
    maxResults: null,
    pageSize: 200,
    all: false,
    start: null,
    end: null,
    from: null,
    to: null,
    positional: [],
    sawProtected: false,
    sawUnprotected: false,
    titleFilter: null,
    descriptionFilter: null,
    locationFilter: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-o" || token === "--output") {
      state.output = requireValue(args, ++i, token);
      continue;
    }
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--all") {
      state.all = true;
      continue;
    }
    if (token === "--start") {
      state.start = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--end") {
      state.end = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--from") {
      state.from = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--to") {
      state.to = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--limit") {
      const value = Number(requireValue(args, ++i, token));
      if (!Number.isInteger(value) || value < 1) {
        throw new CliError("INVALID_ARGS", "--limit must be a positive integer");
      }
      state.maxResults = value;
      continue;
    }
    if (token === "--protected") {
      state.sawProtected = true;
      continue;
    }
    if (token === "--unprotected") {
      state.sawUnprotected = true;
      continue;
    }
    if (token === "--title") {
      state.titleFilter = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--description") {
      state.descriptionFilter = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--location") {
      state.locationFilter = requireValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError("INVALID_ARGS", `Unknown option: ${token}`);
    }
    state.positional.push(token);
  }

  if ((state.start || state.end) && (state.from || state.to)) {
    throw new CliError("INVALID_ARGS", "Use either --start/--end or --from/--to, not both");
  }

  if (state.sawProtected && state.sawUnprotected) {
    throw new CliError("INVALID_ARGS", "Cannot use both --protected and --unprotected");
  }

  return {
    output: normalizeOutput(state.output),
    calendarId: state.calendarId,
    maxResults: state.maxResults,
    pageSize: state.pageSize,
    range: resolveRange(state, nowFn),
    protectedFilter: state.sawProtected ? true : state.sawUnprotected ? false : null,
    titleFilter: normalizeListFilter(state.titleFilter),
    descriptionFilter: normalizeListFilter(state.descriptionFilter),
    locationFilter: normalizeListFilter(state.locationFilter),
  };
}

function matchesListFilters(event, filters) {
  if (filters.protectedFilter !== null && event?.protected !== filters.protectedFilter) {
    return false;
  }

  if (!matchesTextFilter(event?.title, filters.titleFilter)) {
    return false;
  }
  if (!matchesTextFilter(event?.description, filters.descriptionFilter)) {
    return false;
  }
  if (!matchesTextFilter(event?.location, filters.locationFilter)) {
    return false;
  }

  return true;
}

function matchesTextFilter(value, filter) {
  if (filter === null) {
    return true;
  }

  return String(value || "").toLowerCase().includes(filter);
}

async function parseMutationArgs(args, options = {}) {
  const requireEventId = options.requireEventId !== false;
  const state = {
    output: "json",
    calendarId: null,
    eventId: null,
    scope: null,
    occurrenceStart: null,
    timezone: null,
    patchInput: null,
    clearFields: [],
    assignments: [],
  };

  let index = 0;
  if (requireEventId) {
    if (!args[0] || args[0].startsWith("-")) {
      throw new CliError("INVALID_ARGS", "eventId is required");
    }
    state.eventId = args[0];
    index = 1;
  }

  for (let i = index; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-o" || token === "--output") {
      state.output = requireValue(args, ++i, token);
      continue;
    }
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--scope") {
      state.scope = normalizeScope(requireValue(args, ++i, token));
      continue;
    }
    if (token === "--at" || token === "--occurrence-start" || token === "--occurrence") {
      state.occurrenceStart = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--tz" || token === "--timezone") {
      state.timezone = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--patch") {
      state.patchInput = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--clear") {
      state.clearFields.push(normalizeClearField(requireValue(args, ++i, token)));
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError("INVALID_ARGS", `Unknown option: ${token}`);
    }
    state.assignments.push(token);
  }

  if (state.scope && (state.scope === "single" || state.scope === "following") && !state.occurrenceStart) {
    throw new CliError("INVALID_ARGS", "--at is required for --scope single/following");
  }

  const patchFromInput = state.patchInput ? await parsePatchInput(state.patchInput) : {};
  const assignmentPatch = buildPatchFromAssignments(state.assignments);

  const patch = {
    ...patchFromInput,
    ...assignmentPatch,
  };

  if (state.timezone !== null) {
    patch.timezone = state.timezone;
  }

  for (const field of state.clearFields) {
    patch[field] = "";
  }

  validateStringPatchValues(patch, state.clearFields);
  validateTimezonePatch(patch);

  return {
    output: normalizeOutput(state.output),
    calendarId: state.calendarId,
    eventId: state.eventId,
    scope: state.scope,
    occurrenceStart: state.occurrenceStart,
    patch,
  };
}

function parseDeleteArgs(args) {
  if (!args[0] || args[0].startsWith("-")) {
    throw new CliError("INVALID_ARGS", "eventId is required");
  }

  const state = {
    eventId: args[0],
    output: "json",
    calendarId: null,
    scope: null,
    occurrenceStart: null,
  };

  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-o" || token === "--output") {
      state.output = requireValue(args, ++i, token);
      continue;
    }
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--scope") {
      state.scope = normalizeScope(requireValue(args, ++i, token));
      continue;
    }
    if (token === "--at" || token === "--occurrence-start" || token === "--occurrence") {
      state.occurrenceStart = requireValue(args, ++i, token);
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown option: ${token}`);
  }

  if (state.scope && (state.scope === "single" || state.scope === "following") && !state.occurrenceStart) {
    throw new CliError("INVALID_ARGS", "--at is required for --scope single/following");
  }

  return {
    eventId: state.eventId,
    output: normalizeOutput(state.output),
    calendarId: state.calendarId,
    scope: state.scope,
    occurrenceStart: state.occurrenceStart,
  };
}

async function parsePatchInput(raw) {
  if (!raw.startsWith("@")) {
    const parsed = parseJsonObject(raw, "--patch must be a JSON object or @file.json");
    return parsed;
  }

  const filePath = raw.slice(1);
  if (!filePath) {
    throw new CliError("INVALID_ARGS", "--patch @file requires a file path");
  }

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    throw new CliError("INVALID_ARGS", `Unable to read patch file: ${filePath}`);
  }

  return parseJsonObject(content, `Patch file must contain a JSON object: ${filePath}`);
}

function buildPatchFromAssignments(assignments) {
  const patch = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf("=");
    if (idx <= 0) {
      throw new CliError("INVALID_ARGS", `Expected key=value assignment, got: ${assignment}`);
    }
    const key = normalizeFieldPath(assignment.slice(0, idx));
    const value = parseAssignmentValue(assignment.slice(idx + 1));
    setPathValue(patch, key.split("."), value);
  }
  return patch;
}

function normalizeFieldPath(raw) {
  const key = String(raw || "").trim();
  if (!key) {
    throw new CliError("INVALID_ARGS", "Field name cannot be empty");
  }
  if (key === "loc") {
    return "location";
  }
  if (key === "desc") {
    return "description";
  }
  if (key === "tz") {
    return "timezone";
  }
  return key;
}

function validateTimezonePatch(patch) {
  if (!Object.hasOwn(patch, "timezone")) {
    return;
  }

  const timezone = patch.timezone;
  if (typeof timezone !== "string" || !VALID_TIMEZONES.has(timezone)) {
    throw new CliError("INVALID_TIMEZONE", `timezone must be UTC or a valid IANA time zone: ${timezone}`);
  }
}

function validateStringPatchValues(patch, clearFields) {
  const cleared = new Set(clearFields);
  for (const field of ["title", "description", "location"]) {
    if (!Object.hasOwn(patch, field) || cleared.has(field)) {
      continue;
    }
    if (typeof patch[field] === "string" && patch[field].trim() === "") {
      throw new CliError("INVALID_ARGS", `${field} cannot be blank`);
    }
  }
}

function normalizeClearField(raw) {
  const field = normalizeFieldPath(raw);
  if (!CLEARABLE_FIELDS.has(field)) {
    throw new CliError("INVALID_ARGS", `--clear only supports description/location (got ${raw})`);
  }
  return field;
}

function parseAssignmentValue(raw) {
  const value = String(raw);
  const trimmed = value.trim();
  if (trimmed === "null") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function setPathValue(target, parts, value) {
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function resolveRange(state, nowFn) {
  if (state.start || state.end) {
    if (!state.start || !state.end) {
      throw new CliError("INVALID_ARGS", "Both --start and --end are required");
    }
    return validateRange({
      start: parseBoundary(state.start, { end: false }),
      end: parseBoundary(state.end, { end: true }),
    });
  }

  if (state.from || state.to) {
    if (!state.from || !state.to) {
      throw new CliError("INVALID_ARGS", "Both --from and --to are required");
    }
    return validateRange({
      start: parseBoundary(state.from, { end: false }),
      end: parseBoundary(state.to, { end: true }),
    });
  }

  if (state.all) {
    return {
      start: "2000-01-01T00:00:00.000Z",
      end: "2100-01-01T00:00:00.000Z",
    };
  }

  return resolveShortcutRange(state.positional, nowFn);
}

function validateRange(range) {
  validateStartBeforeEnd(range.start, range.end);
  return range;
}

function validateStartBeforeEnd(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    throw new CliError("INVALID_ARGS", "end must be after start");
  }
}

function resolveShortcutRange(positional, nowFn) {
  const now = new Date(nowFn());
  const mode = positional[0] || "w";

  if (mode === "all") {
    return {
      start: "2000-01-01T00:00:00.000Z",
      end: "2100-01-01T00:00:00.000Z",
    };
  }

  if (mode === "w" || mode === "w+" || mode === "w++") {
    const weeks = mode === "w" ? 1 : mode === "w+" ? 2 : 3;
    const weekNumber = positional[1] ? Number(positional[1]) : null;
    const year = positional[2] ? Number(positional[2]) : isoWeekYear(now);

    if (weekNumber !== null) {
      if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) {
        throw new CliError("INVALID_ARGS", "Week number must be 1..53");
      }
      const start = isoWeekStart(year, weekNumber);
      return {
        start: start.toISOString(),
        end: addDays(start, weeks * 7).toISOString(),
      };
    }

    const start = startOfIsoWeek(now);
    return {
      start: start.toISOString(),
      end: addDays(start, weeks * 7).toISOString(),
    };
  }

  if (mode === "m") {
    const month = positional[1] ? Number(positional[1]) : now.getUTCMonth() + 1;
    const year = positional[2] ? Number(positional[2]) : now.getUTCFullYear();

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new CliError("INVALID_ARGS", "Month must be 1..12");
    }
    if (!Number.isInteger(year) || year < 1900 || year > 3000) {
      throw new CliError("INVALID_ARGS", "Year is invalid");
    }

    return {
      start: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      end: new Date(Date.UTC(year, month, 1)).toISOString(),
    };
  }

  if (mode === "y") {
    const year = positional[1] ? Number(positional[1]) : now.getUTCFullYear();
    if (!Number.isInteger(year) || year < 1900 || year > 3000) {
      throw new CliError("INVALID_ARGS", "Year is invalid");
    }

    return {
      start: new Date(Date.UTC(year, 0, 1)).toISOString(),
      end: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
    };
  }

  throw new CliError("INVALID_ARGS", `Unknown list shortcut: ${mode}`);
}

function parseBoundary(raw, options) {
  const value = String(raw || "").trim();
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return new Date(Date.UTC(year, month - 1, day + (options.end ? 1 : 0), 0, 0, 0, 0)).toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CliError("INVALID_ARGS", `Invalid date/time: ${raw}`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOutput(raw) {
  const value = String(raw || "json").trim().toLowerCase();
  if (!["json", "table"].includes(value)) {
    throw new CliError("INVALID_ARGS", `Unsupported output format: ${raw}`);
  }
  return value;
}

function normalizeListFilter(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  return String(raw).trim().toLowerCase();
}

function normalizeScope(raw) {
  const scope = String(raw || "").trim().toLowerCase();
  if (!["single", "following", "series"].includes(scope)) {
    throw new CliError("INVALID_ARGS", "--scope must be single, following, or series");
  }
  return scope;
}

function readBaseUrl(env, localConfig) {
  const raw =
    env.PC_API_BASE_URL ||
    env.API_BASE_URL ||
    (localConfig && typeof localConfig.apiBaseUrl === "string" ? localConfig.apiBaseUrl : "") ||
    DEFAULT_API_BASE_URL;
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new CliError("CONFIG_ERROR", `Invalid PC_API_BASE_URL: ${raw}`);
  }
}

function readToken(env, localConfig) {
  const token =
    env.PC_API_TOKEN ||
    env.API_BEARER_TOKEN ||
    (localConfig && typeof localConfig.apiToken === "string" ? localConfig.apiToken : "");
  if (!token || String(token).trim() === "") {
    throw new CliError(
      "CONFIG_ERROR",
      `Set PC_API_TOKEN/API_BEARER_TOKEN or add apiToken to ${env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH}`
    );
  }
  return String(token).trim();
}

async function readLocalConfig(env) {
  const configPath = env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH;

  try {
    const fileStat = await assertSafeSecretFile(configPath, {
      required: false,
      createError: (message, details) => new CliError("SECRET_FILE_UNSAFE_PERMISSIONS", message, details),
    });
    if (!fileStat) {
      return null;
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("CONFIG_ERROR", `Unable to read local config file: ${configPath}`);
  }

  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw new CliError("CONFIG_ERROR", `Unable to read local config file: ${configPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError("CONFIG_ERROR", `Local config is not valid JSON: ${configPath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("CONFIG_ERROR", `Local config must be a JSON object: ${configPath}`);
  }

  return parsed;
}

async function requestJson(fetchImpl, request) {
  const url = new URL(`${request.apiBaseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${request.apiToken}`,
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError("API_UNREACHABLE", `Unable to reach API at ${request.apiBaseUrl}`, {
      message: error?.message,
    });
  }

  const text = await response.text();
  const payload = parseMaybeJson(text);

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id") || payload?.error?.requestId || null;
    throw new CliError(
      payload?.error?.code || "API_ERROR",
      payload?.error?.message || `API request failed (${response.status})`,
      addRequestIdToDetails(payload?.error?.details, requestId)
    );
  }

  return payload;
}

function parseMaybeJson(text) {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {
      data: {
        raw: text,
      },
    };
  }
}

function sanitizeUpstreamPayload(payload) {
  const details = {};
  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    details.code = payload.Code;
  }
  return details;
}

function addRequestIdToDetails(details, requestId) {
  if (!requestId) {
    return details;
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return { requestId };
  }
  return {
    ...details,
    requestId,
  };
}

function parseJsonObject(raw, errorMessage) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("INVALID_ARGS", errorMessage);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("INVALID_ARGS", errorMessage);
  }
  return parsed;
}

function requireValue(args, index, option) {
  const value = args[index];
  const trimmed = value === undefined || value === null ? "" : String(value).trim();
  if (trimmed === "") {
    throw new CliError("INVALID_ARGS", `${option} requires a value`);
  }
  return trimmed;
}

function writeOutput(stdout, output, payload) {
  if (output === "json") {
    write(stdout, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (Array.isArray(payload?.data?.calendars)) {
    write(stdout, formatCalendarTable(payload.data.calendars));
    return;
  }

  const events = Array.isArray(payload?.data?.events) ? payload.data.events : [];
  if (events.length === 0) {
    write(stdout, "No events\n");
    return;
  }

  const lines = ["id\tstart\tend\ttitle\tlocation\tprotected"];
  for (const event of events) {
    lines.push(
      `${event.id || ""}\t${event.start || ""}\t${event.end || ""}\t${event.title || ""}\t${event.location || ""}\t${event.protected === true ? "yes" : "no"}`
    );
  }
  write(stdout, `${lines.join("\n")}\n`);
}

function formatCalendarTable(calendars) {
  if (calendars.length === 0) {
    return "No calendars\n";
  }

  const lines = ["id\tname\tdefault\ttarget\tcolor\tpermissions"];
  for (const calendar of calendars) {
    lines.push(
      `${calendar.id || ""}\t${calendar.name || ""}\t${calendar.default ? "yes" : "no"}\t${calendar.target ? "yes" : "no"}\t${calendar.color || ""}\t${calendar.permissions ?? ""}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function toCliErrorPayload(error) {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: sanitizeErrorDetails(error.details),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error?.message || "Internal error",
    },
  };
}

function sanitizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return details;
  }

  if (!Object.hasOwn(details, "payload")) {
    return details;
  }

  const { payload, ...rest } = details;
  return {
    ...rest,
    ...sanitizeUpstreamPayload(payload),
  };
}

function write(stream, text) {
  stream.write(text);
}

function startOfIsoWeek(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  return addDays(utc, 1 - day);
}

function isoWeekYear(date) {
  const thursday = addDays(startOfIsoWeek(date), 3);
  return thursday.getUTCFullYear();
}

function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = addDays(jan4, 1 - jan4Day);
  return addDays(week1Monday, (week - 1) * 7);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isEntrypoint) {
  runPcCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
