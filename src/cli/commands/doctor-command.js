import path from "node:path";
import { CookieSessionStore } from "../../session/cookie-session-store.js";
import { normalizeOutput, requireValue } from "../args.js";
import { attemptLoginRefresh, buildProtonHosts, extractRefreshPayload, probeWorkingUid, readAuthDiagnostics, readCookieBundle, readUidCandidates } from "../auth-helpers.js";
import { DEFAULT_COOKIE_BUNDLE_PATH, DEFAULT_PROTON_BASE_URL } from "../constants.js";
import { CliError } from "../errors.js";

export async function runDoctorCommand(args, context) {
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

