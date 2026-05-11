import { readFile } from "node:fs/promises";
import { normalizeOutput, normalizeScope, requireValue } from "../args.js";
import { parseJsonObject, requestJson } from "../api-client.js";
import { CLEARABLE_FIELDS, VALID_TIMEZONES } from "../constants.js";
import { validateStartBeforeEnd } from "../date-range.js";
import { CliError } from "../errors.js";

export async function runCreateCommand(args, context) {
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

  if (parsed.dryRun) {
    return {
      output: "json",
      payload: buildDryRunPayload("create", "POST", path, {}, parsed.patch),
    };
  }

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


export async function runEditCommand(args, context) {
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

  const query = {
    ...(parsed.scope ? { scope: parsed.scope } : {}),
    ...(parsed.occurrenceStart ? { occurrenceStart: parsed.occurrenceStart } : {}),
  };

  if (parsed.dryRun) {
    return {
      output: "json",
      payload: buildDryRunPayload("update", "PATCH", path, query, parsed.patch),
    };
  }

  const response = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "PATCH",
    path,
    query,
    body: parsed.patch,
  });

  return {
    output: parsed.output,
    payload: response,
  };
}


export async function runDeleteCommand(args, context) {
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
    dryRun: false,
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
    if (token === "--dry-run") {
      state.dryRun = true;
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
    patch[field] = field === "notifications" ? null : "";
  }

  validateStringPatchValues(patch, state.clearFields);
  validateTimezonePatch(patch);

  return {
    output: normalizeOutput(state.output),
    calendarId: state.calendarId,
    eventId: state.eventId,
    scope: state.scope,
    occurrenceStart: state.occurrenceStart,
    dryRun: state.dryRun,
    patch,
  };
}


function buildDryRunPayload(operation, method, path, query, payload) {
  return {
    data: {
      dryRun: true,
      operation,
      method,
      path,
      query,
      payload,
    },
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
    throw new CliError("INVALID_ARGS", `--clear only supports description/location/notifications (got ${raw})`);
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
