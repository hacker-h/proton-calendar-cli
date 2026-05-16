import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireValue } from "../args.js";
import { requestJson, requestText } from "../api-client.js";
import { validateStartBeforeEnd } from "../date-range.js";
import { CliError } from "../errors.js";
import { MAX_ICS_IMPORT_BYTES } from "../../ics.js";

export async function runIcsExportCommand(args, context) {
  const parsed = parseExportArgs(args);
  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/ics`
    : "/v1/events/ics";
  return requestText(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "GET",
    path,
    accept: "text/calendar",
    query: parsed.range,
  });
}

export async function runIcsImportCommand(args, context) {
  const parsed = await parseImportArgs(args);
  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/ics`
    : "/v1/events/ics";
  const payload = await requestJson(context.fetchImpl, {
    apiBaseUrl: context.apiBaseUrl,
    apiToken: context.apiToken,
    method: "POST",
    path,
    contentType: "text/calendar; charset=utf-8",
    idempotencyKey: `ics-import-${createHash("sha256").update(parsed.ics).digest("hex").slice(0, 32)}`,
    body: parsed.ics,
  });
  return {
    output: "json",
    payload,
  };
}

function parseExportArgs(args) {
  const state = {
    calendarId: null,
    start: null,
    end: null,
    from: null,
    to: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
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
    throw new CliError("INVALID_ARGS", `Unknown option: ${token}`);
  }

  if ((state.start || state.end) && (state.from || state.to)) {
    throw new CliError("INVALID_ARGS", "Use either --start/--end or --from/--to, not both");
  }
  if (!((state.start && state.end) || (state.from && state.to))) {
    throw new CliError("INVALID_ARGS", "pc export requires an explicit --from/--to or --start/--end range");
  }

  const range = {
    start: parseBoundary(state.start || state.from, { end: false }),
    end: parseBoundary(state.end || state.to, { end: true }),
  };
  validateStartBeforeEnd(range.start, range.end);
  return { calendarId: state.calendarId, range };
}

async function parseImportArgs(args) {
  const state = {
    calendarId: null,
    filePath: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "-c" || token === "--calendar") {
      state.calendarId = requireValue(args, ++i, token);
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError("INVALID_ARGS", `Unknown option: ${token}`);
    }
    if (state.filePath) {
      throw new CliError("INVALID_ARGS", "pc import accepts exactly one ICS file");
    }
    state.filePath = token;
  }

  if (!state.filePath) {
    throw new CliError("INVALID_ARGS", "pc import requires an ICS file path");
  }

  let ics;
  try {
    ics = await readFile(state.filePath, "utf8");
  } catch {
    throw new CliError("INVALID_ARGS", `Unable to read ICS file: ${state.filePath}`);
  }
  if (Buffer.byteLength(ics, "utf8") > MAX_ICS_IMPORT_BYTES) {
    throw new CliError("ICS_IMPORT_TOO_LARGE", "ICS import cannot exceed 10 MB", {
      maxBytes: MAX_ICS_IMPORT_BYTES,
    });
  }
  return { calendarId: state.calendarId, ics };
}

function parseBoundary(value, options) {
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new CliError("INVALID_ARGS", `Invalid date/time: ${value}`);
    }
    if (options.end) {
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return date.toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new CliError("INVALID_ARGS", `Invalid date/time: ${value}`);
  }
  return new Date(parsed).toISOString();
}
