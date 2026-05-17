import { createHash } from "node:crypto";
import { formatVcalWithTzid } from "./ics.js";

export const INVITE_PROTOTYPE_DISABLED = "INVITE_PROTOTYPE_DISABLED";

const API_ATTENDEE_STATUS = Object.freeze({
  "NEEDS-ACTION": 0,
  TENTATIVE: 1,
  DECLINED: 2,
  ACCEPTED: 3,
});

const REQUIRED_API_FIELDS = Object.freeze([
  "Permissions",
  "IsOrganizer",
  "SharedKeyPacket",
  "SharedEventContent",
  "AttendeesEventContent",
  "Attendees",
]);

const ORGANIZER_METHODS = Object.freeze({
  create: "REQUEST",
  update: "REQUEST",
  cancel: "CANCEL",
});

export function buildInvitePrototypeParts(input, options = {}) {
  if (options.enabled !== true) {
    const error = new Error("Attendee invitation payload building is a disabled research prototype");
    error.code = INVITE_PROTOTYPE_DISABLED;
    throw error;
  }

  const uid = requireNonEmpty(input.uid, "uid");
  const organizerEmail = normalizeEmail(input.organizerEmail, "organizerEmail");
  const attendees = normalizeAttendees(input.attendees || [], organizerEmail, uid);
  const action = normalizeAction(input.action);
  const method = ORGANIZER_METHODS[action];
  const sequence = Number.isInteger(input.sequence) ? input.sequence : 0;
  const now = new Date(input.dtstamp || new Date());
  const created = new Date(input.createdDate || now);
  const timezone = input.timezone || "UTC";
  const start = formatDateProperty("DTSTART", input.startDate, timezone);
  const end = formatDateProperty("DTEND", input.endDate, timezone);

  const sharedSignedPart = buildVevent([
    ["UID", uid],
    ["DTSTAMP", formatVcalUtc(now)],
    [start.key, start.value],
    [end.key, end.value],
    [`ORGANIZER;CN=${escapeIcsParam(organizerEmail)}`, `mailto:${organizerEmail}`],
    ["SEQUENCE", String(sequence)],
  ], { method });

  const sharedEncryptedPart = buildVevent([
    ["UID", uid],
    ["DTSTAMP", formatVcalUtc(now)],
    ["CREATED", formatVcalUtc(created)],
    ["SUMMARY", escapeIcsText(input.title || "")],
    ["DESCRIPTION", escapeIcsText(input.description || "")],
    ["LOCATION", escapeIcsText(input.location || "")],
  ], { method });

  const attendeesEncryptedPart = buildVevent([
    ["UID", uid],
    ["DTSTAMP", formatVcalUtc(now)],
    ...attendees.map((attendee) => [`ATTENDEE;${formatAttendeeParameters(attendee)}`, `mailto:${attendee.email}`]),
  ], { method });

  return {
    action,
    method,
    methodByAction: ORGANIZER_METHODS,
    requiredApiFields: REQUIRED_API_FIELDS,
    sharedSignedPart,
    sharedEncryptedPart,
    attendeesEncryptedPart,
    clearAttendees: attendees.map((attendee) => ({
      Token: attendee.token,
      Status: API_ATTENDEE_STATUS[attendee.partstat],
    })),
  };
}

function normalizeAction(value) {
  const action = String(value || "create").trim().toLowerCase();
  if (!Object.hasOwn(ORGANIZER_METHODS, action)) {
    throw new Error("unsupported invite prototype action");
  }
  return action;
}

function normalizeAttendees(attendees, organizerEmail, uid) {
  if (!Array.isArray(attendees) || attendees.length === 0) {
    throw new Error("at least one attendee is required");
  }

  const seen = new Set();
  return attendees.map((raw) => {
    const email = normalizeEmail(raw?.email, "attendee.email");
    if (email === organizerEmail) {
      throw new Error("organizer cannot also be an attendee");
    }
    if (seen.has(email)) {
      throw new Error("duplicate attendees are not supported");
    }
    seen.add(email);
    const partstat = normalizePartstat(raw?.partstat);
    const cn = String(raw?.name || email).trim();
    return {
      email,
      cn,
      role: normalizeRole(raw?.role),
      rsvp: raw?.rsvp === false ? "FALSE" : "TRUE",
      partstat,
      token: generateAttendeeToken(email, uid),
    };
  });
}

function generateAttendeeToken(email, seed) {
  return createHash("sha1").update(`${String(seed)}${email}`).digest("hex");
}

function normalizePartstat(value) {
  const partstat = String(value || "NEEDS-ACTION").trim().toUpperCase();
  if (!Object.hasOwn(API_ATTENDEE_STATUS, partstat)) {
    throw new Error("unsupported attendee partstat");
  }
  return partstat;
}

function normalizeRole(value) {
  const role = String(value || "REQ-PARTICIPANT").trim().toUpperCase();
  if (!["REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT"].includes(role)) {
    throw new Error("unsupported attendee role");
  }
  return role;
}

function normalizeEmail(value, field) {
  const email = requireNonEmpty(value, field).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`${field} must be an email address`);
  }
  return email;
}

function requireNonEmpty(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function formatDateProperty(name, value, timezone) {
  if (!value) {
    throw new Error(`${name.toLowerCase()} is required`);
  }
  if (!timezone || timezone === "UTC") {
    return { key: name, value: formatVcalUtc(value) };
  }
  const formatted = formatVcalWithTzid(value, timezone);
  return { key: formatted.key.replace("DTSTART", name), value: formatted.value };
}

function formatAttendeeParameters(attendee) {
  return [
    `CN=${escapeIcsParam(attendee.cn)}`,
    `ROLE=${attendee.role}`,
    `PARTSTAT=${attendee.partstat}`,
    `RSVP=${attendee.rsvp}`,
    `X-PM-TOKEN=${attendee.token}`,
  ].join(";");
}

function buildVevent(properties, options = {}) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//proton-calendar-api//EN", "BEGIN:VEVENT"];
  if (options.method) {
    lines.splice(2, 0, `METHOD:${options.method}`);
  }
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

function formatVcalUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid invite date");
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function escapeIcsParam(value) {
  return escapeIcsText(value).replace(/:/g, "\\:");
}
