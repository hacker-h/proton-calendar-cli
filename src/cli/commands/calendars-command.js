import path from "node:path";
import { normalizeOutput, requireValue } from "../args.js";
import { requestJson } from "../api-client.js";
import { DEFAULT_SERVER_ENV_PATH } from "../constants.js";
import { CliError } from "../errors.js";
import { updateServerEnvCalendarConfig } from "../server-env.js";

export async function runCalendarsCommand(args, context) {
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


