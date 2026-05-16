import { Temporal } from "@js-temporal/polyfill";
import { ApiError } from "./errors.js";
import { parseIcsRecurrence } from "./proton/internal/ics.js";

export const MAX_ICS_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_ICS_IMPORT_EVENTS = 15000;
export const MAX_ICS_EXPORT_EVENTS = 15000;
export const MAX_ICS_LOCAL_IMPORT_EVENTS = 50;

const SUPPORTED_VEVENT_PROPERTIES = new Set([
  "UID",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "DTSTART",
  "DTEND",
  "RRULE",
  "STATUS",
]);
const IGNORED_VEVENT_PROPERTIES = new Set([
  "CREATED",
  "LAST-MODIFIED",
  "SEQUENCE",
  "DTSTAMP",
  "TRANSP",
  "STATUS",
  "CLASS",
  "PRIORITY",
]);
const ALLOWED_COMPONENTS = new Set(["VCALENDAR", "VEVENT", "VTIMEZONE", "STANDARD", "DAYLIGHT"]);

export function assertIcsImportSize(raw) {
  const bytes = Buffer.byteLength(String(raw || ""), "utf8");
  if (bytes > MAX_ICS_IMPORT_BYTES) {
    throw new ApiError(413, "ICS_IMPORT_TOO_LARGE", "ICS import cannot exceed 10 MB", {
      maxBytes: MAX_ICS_IMPORT_BYTES,
    });
  }
}

export function parseIcsEvents(raw) {
  assertIcsImportSize(raw);
  const lines = unfoldIcsLines(raw);
  const events = [];
  const unsupported = [];
  const stack = [];
  let current = null;

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }

    const left = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const { name, params } = parsePropertyLeft(left);

    if (name === "BEGIN") {
      const component = value.trim().toUpperCase();
      if (!ALLOWED_COMPONENTS.has(component)) {
        unsupported.push(component);
      }
      stack.push(component);
      if (component === "VEVENT") {
        current = { properties: new Map(), unsupportedProperties: [] };
      }
      continue;
    }

    if (name === "END") {
      const component = value.trim().toUpperCase();
      if (component === "VEVENT" && current) {
        events.push(buildEventInput(current, events.length));
        current = null;
      }
      stack.pop();
      continue;
    }

    if (!current || stack.at(-1) !== "VEVENT") {
      continue;
    }

    if (!SUPPORTED_VEVENT_PROPERTIES.has(name) && !IGNORED_VEVENT_PROPERTIES.has(name)) {
      current.unsupportedProperties.push(name);
      continue;
    }

    if (SUPPORTED_VEVENT_PROPERTIES.has(name) && !current.properties.has(name)) {
      current.properties.set(name, { name, params, value });
    }
  }

  if (unsupported.length > 0) {
    throw new ApiError(422, "ICS_UNSUPPORTED_COMPONENT", "ICS contains unsupported components", {
      components: [...new Set(unsupported)].sort(),
    });
  }
  if (events.length > MAX_ICS_IMPORT_EVENTS) {
    throw new ApiError(413, "ICS_IMPORT_EVENT_LIMIT", "ICS import cannot exceed 15000 events", {
      maxEvents: MAX_ICS_IMPORT_EVENTS,
    });
  }
  return { events, count: events.length };
}

export function assertLocalIcsImportEventLimit(count) {
  if (count > MAX_ICS_LOCAL_IMPORT_EVENTS) {
    throw new ApiError(413, "ICS_IMPORT_BATCH_TOO_LARGE", "Local ICS import cannot create more than 50 events per request", {
      maxEvents: MAX_ICS_LOCAL_IMPORT_EVENTS,
    });
  }
}

export function exportEventsToIcs(events) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//proton-calendar-cli//ICS Export//EN", "CALSCALE:GREGORIAN"];
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(foldIcsLine(`UID:${escapeIcsText(event.uid || event.id || cryptoSafeUid(event))}`));
    lines.push(foldIcsLine(`DTSTAMP:${formatUtc(new Date())}`));
    lines.push(foldIcsLine(`SUMMARY:${escapeIcsText(event.title || "")}`));
    if (event.description) {
      lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    }
    if (event.location) {
      lines.push(foldIcsLine(`LOCATION:${escapeIcsText(event.location)}`));
    }
    lines.push(...formatEventTimeLines(event));
    const rrule = event.occurrenceStart || event.seriesId ? "" : formatRRule(event.recurrence);
    if (rrule) {
      lines.push(foldIcsLine(`RRULE:${rrule}`));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

function buildEventInput(record, index) {
  if (record.unsupportedProperties.length > 0) {
    throw new ApiError(422, "ICS_UNSUPPORTED_PROPERTY", "VEVENT contains unsupported properties", {
      eventIndex: index,
      properties: [...new Set(record.unsupportedProperties)].sort(),
    });
  }

  const properties = Object.fromEntries(record.properties);
  const dtstart = properties.DTSTART;
  const dtend = properties.DTEND;
  if (!dtstart || !dtend) {
    throw new ApiError(422, "ICS_INVALID_EVENT", "VEVENT requires DTSTART and DTEND", { eventIndex: index });
  }
  if (String(properties.STATUS?.value || "").trim().toUpperCase() === "CANCELLED") {
    throw new ApiError(422, "ICS_CANCELLED_EVENT", "Cancelled VEVENTs cannot be imported as active events", { eventIndex: index });
  }

  const allDay = readParam(dtstart.params, "VALUE").toUpperCase() === "DATE";
  const timezone = allDay ? readParam(dtstart.params, "TZID") || "UTC" : readTimezone(dtstart, dtend);
  const start = parseIcsDateValue(dtstart.value, { allDay, timezone });
  const end = parseIcsDateValue(dtend.value, { allDay, timezone });
  const event = {
    title: unescapeIcsText(properties.SUMMARY?.value || properties.UID?.value || "Imported event"),
    description: unescapeIcsText(properties.DESCRIPTION?.value || ""),
    location: unescapeIcsText(properties.LOCATION?.value || ""),
    start,
    end,
    allDay,
    timezone,
    protected: true,
  };

  if (properties.RRULE) {
    event.recurrence = parseIcsRecurrence({ RRULE: properties.RRULE.value });
  }
  return event;
}

function readTimezone(dtstart, dtend) {
  if (dtstart.value.endsWith("Z") && dtend.value.endsWith("Z")) {
    return "UTC";
  }
  return readParam(dtstart.params, "TZID") || readParam(dtend.params, "TZID") || "UTC";
}

function parseIcsDateValue(value, options) {
  const raw = String(value || "").trim();
  if (options.allDay) {
    if (!/^\d{8}$/.test(raw)) {
      throw new ApiError(422, "ICS_INVALID_DATE", "All-day ICS dates must use YYYYMMDD");
    }
    assertSupportedTimezone(options.timezone || "UTC");
    assertValidPlainDate(Number(raw.slice(0, 4)), Number(raw.slice(4, 6)), Number(raw.slice(6, 8)));
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) {
    throw new ApiError(422, "ICS_INVALID_DATE", "Timed ICS dates must use YYYYMMDDTHHMMSS or UTC Z form");
  }
  const [, year, month, day, hour, minute, second, zulu] = match;
  const plain = createPlainDateTime({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  });
  if (zulu) {
    return plain.toZonedDateTime("UTC").toInstant().toString();
  }
  try {
    return plain.toZonedDateTime(options.timezone || "UTC").toInstant().toString();
  } catch {
    throw new ApiError(422, "ICS_INVALID_TIMEZONE", "ICS timezone is not supported", {
      timezone: options.timezone || "UTC",
    });
  }
}

function assertSupportedTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new ApiError(422, "ICS_INVALID_TIMEZONE", "ICS timezone is not supported", {
      timezone,
    });
  }
}

function assertValidPlainDate(year, month, day) {
  try {
    Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
  } catch {
    throw new ApiError(422, "ICS_INVALID_DATE", "ICS dates must be real calendar dates");
  }
}

function createPlainDateTime(fields) {
  try {
    return Temporal.PlainDateTime.from(fields, { overflow: "reject" });
  } catch {
    throw new ApiError(422, "ICS_INVALID_DATE", "ICS dates must be real date-times");
  }
}

function formatEventTimeLines(event) {
  if (event.allDay) {
    return [
      foldIcsLine(`DTSTART;VALUE=DATE:${formatDateOnly(event.start, event.timezone || "UTC")}`),
      foldIcsLine(`DTEND;VALUE=DATE:${formatDateOnly(event.end, event.timezone || "UTC")}`),
    ];
  }
  if (event.timezone && event.timezone !== "UTC") {
    return [
      foldIcsLine(`DTSTART;TZID=${event.timezone}:${formatLocalDateTime(event.start, event.timezone)}`),
      foldIcsLine(`DTEND;TZID=${event.timezone}:${formatLocalDateTime(event.end, event.timezone)}`),
    ];
  }
  return [foldIcsLine(`DTSTART:${formatUtc(event.start)}`), foldIcsLine(`DTEND:${formatUtc(event.end)}`)];
}

function formatRRule(recurrence) {
  if (!recurrence || typeof recurrence !== "object") {
    return "";
  }
  const parts = [["FREQ", String(recurrence.freq || "").toUpperCase()]];
  if (!parts[0][1]) {
    return "";
  }
  if (Number.isInteger(recurrence.interval) && recurrence.interval > 1) {
    parts.push(["INTERVAL", String(recurrence.interval)]);
  }
  if (Number.isInteger(recurrence.count) && recurrence.count > 0) {
    parts.push(["COUNT", String(recurrence.count)]);
  }
  if (recurrence.until) {
    parts.push(["UNTIL", formatUtc(recurrence.until)]);
  }
  if (Array.isArray(recurrence.byDay) && recurrence.byDay.length > 0) {
    parts.push(["BYDAY", recurrence.byDay.map((day) => String(day).toUpperCase()).join(",")]);
  }
  if (Array.isArray(recurrence.byMonthDay) && recurrence.byMonthDay.length > 0) {
    parts.push(["BYMONTHDAY", recurrence.byMonthDay.join(",")]);
  }
  if (recurrence.weekStart) {
    parts.push(["WKST", String(recurrence.weekStart).toUpperCase()]);
  }
  return parts.map(([key, value]) => `${key}=${value}`).join(";");
}

function parsePropertyLeft(left) {
  const [rawName, ...rawParams] = left.split(";");
  const params = new Map();
  for (const rawParam of rawParams) {
    const index = rawParam.indexOf("=");
    if (index <= 0) {
      continue;
    }
    params.set(rawParam.slice(0, index).toUpperCase(), rawParam.slice(index + 1));
  }
  return { name: rawName.toUpperCase(), params };
}

function readParam(params, name) {
  return String(params.get(name.toUpperCase()) || "").replace(/^"|"$/g, "");
}

function unfoldIcsLines(raw) {
  const unfolded = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
      continue;
    }
    unfolded.push(line);
  }
  return unfolded;
}

function foldIcsLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) {
    return line;
  }
  const parts = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && bytes + charBytes > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74;
    }
    current += char;
    bytes += charBytes;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

function escapeIcsText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\r\n/g, "\\n").replace(/[\r\n]/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function unescapeIcsText(value) {
  let output = "";
  const input = String(value);
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char !== "\\" || index === input.length - 1) {
      output += char;
      continue;
    }
    const next = input[index + 1];
    index += 1;
    if (next === "n" || next === "N") {
      output += "\n";
      continue;
    }
    if (next === "," || next === ";" || next === "\\") {
      output += next;
      continue;
    }
    output += `\\${next}`;
  }
  return output;
}

function formatUtc(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatDateOnly(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}${get("month")}${get("day")}`;
}

function formatLocalDateTime(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

function cryptoSafeUid(event) {
  return `${String(event.calendarId || "calendar")}-${String(event.start || "start")}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}
