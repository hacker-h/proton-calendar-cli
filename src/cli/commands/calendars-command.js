import path from "node:path";
import { normalizeOutput, requireValue } from "../args.js";
import { parseJsonObject, requestJson } from "../api-client.js";
import { DEFAULT_SERVER_ENV_PATH } from "../constants.js";
import { CliError } from "../errors.js";
import { updateServerEnvCalendarConfig } from "../server-env.js";

export async function runCalendarsCommand(args, context) {
  const parsed = parseCalendarsArgs(args, context.env);
  if (parsed.operation !== "list") {
    const response = await runCalendarApiOperation(parsed, context);
    return {
      output: parsed.output,
      payload: response,
    };
  }

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


async function runCalendarApiOperation(parsed, context) {
  const path = buildCalendarApiPath(parsed);
  if (parsed.operation === "get-user-settings" || parsed.operation === "get-settings") {
    return requestJson(context.fetchImpl, {
      apiBaseUrl: context.apiBaseUrl,
      apiToken: context.apiToken,
      method: "GET",
      path,
    });
  }

  return requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "PATCH",
    path,
    body: parsed.patch,
  });
}

function buildCalendarApiPath(parsed) {
  if (parsed.operation === "get-user-settings" || parsed.operation === "update-user-settings") {
    return "/v1/calendar-settings";
  }
  if (!parsed.calendarId) {
    throw new CliError("INVALID_ARGS", "--calendar is required for per-calendar settings or metadata");
  }
  if (parsed.operation === "get-settings" || parsed.operation === "update-settings") {
    return `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/settings`;
  }
  return `/v1/calendars/${encodeURIComponent(parsed.calendarId)}`;
}

function parseCalendarsArgs(args, env) {
  const state = {
    output: "json",
    defaultCalendarId: null,
    calendarId: null,
    settings: false,
    patchInput: null,
    assignments: [],
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
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--settings") {
      state.settings = true;
      continue;
    }
    if (token === "--patch") {
      state.patchInput = requireValue(args, ++i, token);
      continue;
    }
    if (token === "--server-env") {
      state.serverEnvPath = path.resolve(requireValue(args, ++i, token));
      continue;
    }
    if (!token.startsWith("-")) {
      state.assignments.push(token);
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown calendars option: ${token}`);
  }
  const patch = buildPatch(state.patchInput, state.assignments);
  const hasPatch = Object.keys(patch).length > 0;
  if (state.defaultCalendarId && (state.settings || state.calendarId || hasPatch)) {
    throw new CliError("INVALID_ARGS", "--set-default cannot be combined with calendar API settings or metadata updates");
  }
  const operation = resolveOperation(state, hasPatch);
  return {
    output: normalizeOutput(state.output),
    defaultCalendarId: state.defaultCalendarId,
    calendarId: state.calendarId,
    operation,
    patch,
    serverEnvPath: state.serverEnvPath,
  };
}

function resolveOperation(state, hasPatch) {
  if (state.defaultCalendarId) {
    return "list";
  }
  if (state.settings && state.calendarId) {
    return hasPatch ? "update-settings" : "get-settings";
  }
  if (state.settings) {
    return hasPatch ? "update-user-settings" : "get-user-settings";
  }
  if (state.calendarId || hasPatch) {
    if (!state.calendarId) {
      throw new CliError("INVALID_ARGS", "--calendar is required for metadata updates");
    }
    if (!hasPatch) {
      throw new CliError("INVALID_ARGS", "metadata updates require field=value or --patch");
    }
    return "update-metadata";
  }
  return "list";
}

function buildPatch(patchInput, assignments) {
  const patch = {
    ...(patchInput ? parseJsonObject(patchInput, "--patch must be a JSON object") : {}),
    ...buildPatchFromAssignments(assignments),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string") {
      patch[key] = value.trim();
    }
  }
  return patch;
}

function buildPatchFromAssignments(assignments) {
  const patch = {};
  for (const assignment of assignments) {
    const idx = assignment.indexOf("=");
    if (idx <= 0) {
      throw new CliError("INVALID_ARGS", `Expected key=value assignment, got: ${assignment}`);
    }
    const key = assignment.slice(0, idx).trim();
    if (!key) {
      throw new CliError("INVALID_ARGS", "Field name cannot be empty");
    }
    patch[key] = parseAssignmentValue(assignment.slice(idx + 1), key);
  }
  return patch;
}

function parseAssignmentValue(raw, key) {
  const value = String(raw);
  const trimmed = value.trim();
  if (["name", "description", "color", "defaultCalendarId"].includes(key)) {
    return trimmed;
  }
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
