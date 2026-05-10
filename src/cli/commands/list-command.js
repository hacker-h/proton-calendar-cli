import { normalizeOutput, requireValue } from "../args.js";
import { requestJson } from "../api-client.js";
import { LIST_PAGE_LIMIT } from "../constants.js";
import { validateStartBeforeEnd } from "../date-range.js";
import { CliError } from "../errors.js";

export async function runListCommand(args, context) {
  const parsed = parseListArgs(args, context.now);
  const path = parsed.calendarId
    ? `/v1/calendars/${encodeURIComponent(parsed.calendarId)}/events`
    : "/v1/events";

  const events = [];
  let cursor = null;
  let nextCursor = null;
  let pages = 0;
  let maxResultsSatisfied = false;

  while (pages < LIST_PAGE_LIMIT) {
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
    pages += 1;

    const rows = Array.isArray(response?.data?.events) ? response.data.events : [];
    events.push(...rows);

    nextCursor = response?.data?.nextCursor || null;
    if (!nextCursor) {
      break;
    }
    if (parsed.maxResults !== null && events.filter((event) => matchesListFilters(event, parsed)).length >= parsed.maxResults) {
      maxResultsSatisfied = true;
      break;
    }

    cursor = nextCursor;
  }

  if (nextCursor && !maxResultsSatisfied) {
    throw new CliError("EVENT_LIST_PAGE_LIMIT", "Event listing exceeded the page limit", {
      range: parsed.range,
      pageLimit: LIST_PAGE_LIMIT,
      pageSize: parsed.pageSize,
      nextCursor,
    });
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


function resolveShortcutRange(positional, nowFn) {
  const now = new Date(nowFn());
  const mode = positional[0] || "w";

  if (mode === "all") {
    return {
      start: "2000-01-01T00:00:00.000Z",
      end: "2100-01-01T00:00:00.000Z",
    };
  }

  if (mode === "today" || mode === "td") {
    const start = startOfUtcDay(now);
    return {
      start: start.toISOString(),
      end: addDays(start, 1).toISOString(),
    };
  }

  if (mode === "tomorrow" || mode === "tm") {
    const start = addDays(startOfUtcDay(now), 1);
    return {
      start: start.toISOString(),
      end: addDays(start, 1).toISOString(),
    };
  }

  if (mode === "next") {
    const days = Number(positional[1]);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw new CliError("INVALID_ARGS", "next window days must be an integer between 1 and 366");
    }
    if (positional[2] && positional[2] !== "day" && positional[2] !== "days") {
      throw new CliError("INVALID_ARGS", "next window only accepts an optional 'days' suffix");
    }
    if (positional.length > 3) {
      throw new CliError("INVALID_ARGS", "next window accepts only a day count");
    }
    const start = startOfUtcDay(now);
    return {
      start: start.toISOString(),
      end: addDays(start, days).toISOString(),
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


function normalizeListFilter(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  return String(raw).trim().toLowerCase();
}


function startOfIsoWeek(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay();
  return addDays(utc, 1 - day);
}


function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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
