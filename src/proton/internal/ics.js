export function formatVcalWithTzid(date, timezone) {
  if (!timezone || timezone === "UTC") {
    return { key: "DTSTART", value: formatVcalUtc(date) };
  }
  // Format as local time with TZID parameter
  const asDate = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(asDate);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const local = `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
  return { key: `DTSTART;TZID=${timezone}`, value: local };
}

export function buildSharedParts({
  uid,
  sequence,
  organizerEmail: _organizerEmail,
  startDate,
  endDate,
  allDay = false,
  title,
  description,
  location,
  recurrence,
  createdDate,
  timezone,
}) {
  const now = new Date();
  const dtstamp = formatVcalUtc(now);
  const created = formatVcalUtc(createdDate || now);

  const effectiveTimezone = timezone || "UTC";
  const dtstartFormatted = allDay
    ? { key: "DTSTART;VALUE=DATE", value: formatVcalDate(startDate, effectiveTimezone) }
    : effectiveTimezone !== "UTC"
      ? formatVcalWithTzid(startDate, effectiveTimezone)
      : { key: "DTSTART", value: formatVcalUtc(startDate) };
  const dtendFormatted = allDay
    ? { key: "DTEND;VALUE=DATE", value: formatAllDayEndDate(endDate, effectiveTimezone) }
    : effectiveTimezone !== "UTC"
      ? { key: dtstartFormatted.key.replace("DTSTART", "DTEND"), value: formatVcalWithTzid(endDate, effectiveTimezone).value }
      : { key: "DTEND", value: formatVcalUtc(endDate) };

  // DO NOT add ORGANIZER here. Proton's UI treats any signed VEVENT with an
  // ORGANIZER property as an invitation (getEventInformation.ts:
  // `isInvitation: !!model.organizer`) and blocks edit/move unless the
  // current user matches the organizer email (getCanEditSharedEventData in
  // event.ts). Native Proton clients only emit ORGANIZER for events with
  // real attendees; including it on personal events makes them read-only.
  const signedProperties = [
    ["UID", uid],
    ["DTSTAMP", dtstamp],
    [dtstartFormatted.key, dtstartFormatted.value],
    [dtendFormatted.key, dtendFormatted.value],
    ["SEQUENCE", String(sequence)],
  ];

  const encryptedProperties = [
    ["UID", uid],
    ["DTSTAMP", dtstamp],
    ["CREATED", created],
    ["SUMMARY", escapeIcsText(title || "")],
    ["DESCRIPTION", escapeIcsText(description || "")],
    ["LOCATION", escapeIcsText(location || "")],
  ];

  const recurrenceRule = formatIcsRecurrenceRule(recurrence);
  if (recurrenceRule) {
    signedProperties.push(["RRULE", recurrenceRule]);
    encryptedProperties.push(["RRULE", recurrenceRule]);
  }

  const exdates = formatIcsExdates(recurrence?.exDates || []);
  if (exdates) {
    encryptedProperties.push(["EXDATE", exdates]);
  }

  return {
    signedPart: buildVcalendarVevent(signedProperties),
    encryptedPart: buildVcalendarVevent(encryptedProperties),
  };
}

function buildVcalendarVevent(properties) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//proton-calendar-api//EN", "BEGIN:VEVENT"];
  for (const [key, value] of properties) {
    if (value === undefined || value === null || String(value) === "") {
      continue;
    }
    lines.push(foldIcsLine(`${key}:${value}`));
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
}

function foldIcsLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 75) {
    return line;
  }

  const segments = [];
  let segment = "";
  let segmentBytes = 0;
  let limit = 75;

  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (segment && segmentBytes + charBytes > limit) {
      segments.push(segment);
      segment = "";
      segmentBytes = 0;
      limit = 74;
    }
    segment += char;
    segmentBytes += charBytes;
  }

  if (segment) {
    segments.push(segment);
  }

  return segments.map((part, index) => (index === 0 ? part : ` ${part}`)).join("\r\n");
}

function unfoldIcsLines(ics) {
  if (!ics || typeof ics !== "string") {
    return [];
  }

  const unfolded = [];
  for (const rawLine of ics.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += rawLine.slice(1);
      continue;
    }
    unfolded.push(rawLine);
  }
  return unfolded;
}

export function parseVeventProperties(ics) {
  if (!ics || typeof ics !== "string") {
    return {};
  }

  const unfolded = unfoldIcsLines(ics);

  const beginIndex = unfolded.findIndex((line) => line === "BEGIN:VEVENT");
  const endIndex = unfolded.findIndex((line) => line === "END:VEVENT");
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    return {};
  }

  const props = {};
  for (const line of unfolded.slice(beginIndex + 1, endIndex)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const keyWithParams = line.slice(0, separator).toUpperCase();
    const key = keyWithParams.split(";")[0];
    const value = line.slice(separator + 1);
    props[key] = value;
  }

  return props;
}

export function hasDateValueProperty(ics, propertyName) {
  const prefix = propertyName.toUpperCase();
  for (const line of unfoldIcsLines(ics)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const left = line.slice(0, separator).toUpperCase();
    if (left === prefix) {
      return false;
    }
    if (!left.startsWith(`${prefix};`)) {
      continue;
    }
    const params = left.slice(prefix.length + 1);
    if (/(^|;)VALUE=DATE($|;)/.test(params)) {
      return true;
    }
  }
  return false;
}

function formatVcalUtc(date) {
  const asDate = date instanceof Date ? date : new Date(date);
  const iso = asDate.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatVcalDate(date, timezone = "UTC") {
  const parts = getDateTimeParts(date, timezone);
  return `${parts.year}${parts.month}${parts.day}`;
}

function formatAllDayEndDate(date, timezone) {
  const stamp = formatVcalDate(date, timezone);
  return isMidnightInTimeZone(date, timezone) ? stamp : incrementDateStamp(stamp);
}

function incrementDateStamp(stamp) {
  const parsed = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10).replace(/-/g, "");
}

function isMidnightInTimeZone(date, timezone) {
  const parts = getDateTimeParts(date, timezone);
  return parts.hour === "00" && parts.minute === "00" && parts.second === "00";
}

function getDateTimeParts(date, timezone) {
  const asDate = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(asDate);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function parseVcalUtc(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) {
    return null;
  }
  const [, y, m, d, hh, mm, ss] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function unescapeIcsText(value) {
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export function parseIcsRecurrence(props) {
  const rruleRaw = props.RRULE;
  if (!rruleRaw || typeof rruleRaw !== "string") {
    return null;
  }

  const parts = {};
  for (const pair of rruleRaw.split(";")) {
    const [keyRaw, valueRaw] = pair.split("=");
    const key = String(keyRaw || "").trim().toUpperCase();
    const value = String(valueRaw || "").trim();
    if (!key || !value) {
      continue;
    }
    parts[key] = value;
  }

  if (!parts.FREQ) {
    return null;
  }

  const recurrence = {
    freq: parts.FREQ,
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ? parseIcsRruleDate(parts.UNTIL) : null,
    byDay: parts.BYDAY
      ? parts.BYDAY
          .split(",")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean)
      : [],
    byMonthDay: parts.BYMONTHDAY
      ? parts.BYMONTHDAY
          .split(",")
          .map((item) => Number(item.trim()))
          .filter((value) => Number.isInteger(value))
      : [],
    weekStart: parts.WKST || null,
    exDates: parseIcsExdates(props.EXDATE),
  };

  return recurrence;
}

function formatIcsRecurrenceRule(recurrence) {
  if (!recurrence || typeof recurrence !== "object") {
    return "";
  }

  const freq = String(recurrence.freq || "").trim().toUpperCase();
  if (!freq) {
    return "";
  }

  const fields = [["FREQ", freq]];

  if (Number.isInteger(recurrence.interval) && recurrence.interval > 1) {
    fields.push(["INTERVAL", String(recurrence.interval)]);
  }
  if (Number.isInteger(recurrence.count) && recurrence.count > 0) {
    fields.push(["COUNT", String(recurrence.count)]);
  }
  if (recurrence.until) {
    fields.push(["UNTIL", formatVcalUtc(recurrence.until)]);
  }

  if (Array.isArray(recurrence.byDay) && recurrence.byDay.length > 0) {
    const byDay = recurrence.byDay.map((item) => String(item).trim().toUpperCase()).filter(Boolean).join(",");
    if (byDay) {
      fields.push(["BYDAY", byDay]);
    }
  }

  if (Array.isArray(recurrence.byMonthDay) && recurrence.byMonthDay.length > 0) {
    const byMonthDay = recurrence.byMonthDay
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 1 && item <= 31)
      .join(",");
    if (byMonthDay) {
      fields.push(["BYMONTHDAY", byMonthDay]);
    }
  }

  if (recurrence.weekStart) {
    fields.push(["WKST", String(recurrence.weekStart).trim().toUpperCase()]);
  }

  return fields.map(([key, value]) => `${key}=${value}`).join(";");
}

function parseIcsExdates(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  return raw
    .split(",")
    .map((item) => parseIcsRruleDate(item.trim()))
    .filter(Boolean);
}

function formatIcsExdates(exDates) {
  if (!Array.isArray(exDates) || exDates.length === 0) {
    return "";
  }

  const values = exDates
    .map((value) => {
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) {
        return "";
      }
      return formatVcalUtc(new Date(parsed));
    })
    .filter(Boolean);

  return values.join(",");
}

function parseIcsRruleDate(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  const parsedVcal = parseVcalUtc(trimmed);
  if (parsedVcal) {
    return parsedVcal.toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}
