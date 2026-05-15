const FRIENDLY_REMINDER_FIELDS = ["reminder", "reminders"];
const FRIENDLY_REMINDER_TYPES = Object.freeze({
  default: 1,
});

export function normalizeFriendlyReminderFields(payload, makeError) {
  const hasReminder = Object.hasOwn(payload, "reminder");
  const hasReminders = Object.hasOwn(payload, "reminders");
  if (!hasReminder && !hasReminders) {
    return payload;
  }
  if (Object.hasOwn(payload, "notifications")) {
    throw makeError("reminder/reminders cannot be combined with notifications");
  }
  if (hasReminder && hasReminders) {
    throw makeError("Use either reminder or reminders, not both");
  }

  const field = hasReminder ? "reminder" : "reminders";
  const normalized = { ...payload };
  for (const key of FRIENDLY_REMINDER_FIELDS) {
    delete normalized[key];
  }
  normalized.notifications = parseFriendlyReminders(payload[field], field, makeError);
  return normalized;
}

function parseFriendlyReminders(raw, field, makeError) {
  if (typeof raw !== "string") {
    throw makeError(`${field} must be a string such as 10m or 1h`);
  }
  const tokens = field === "reminder" ? [raw.trim()] : raw.split(",").map((part) => part.trim());
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    throw makeError(`${field} must include at least one reminder`);
  }
  if (tokens.length > 10) {
    throw makeError("reminders cannot contain more than 10 entries");
  }
  return tokens.map((token) => parseFriendlyReminderToken(token, makeError));
}

function parseFriendlyReminderToken(token, makeError) {
  const separatorIndex = token.indexOf(":");
  const channel = separatorIndex === -1 ? "default" : token.slice(0, separatorIndex).trim().toLowerCase();
  const duration = separatorIndex === -1 ? token : token.slice(separatorIndex + 1).trim();
  if (!Object.hasOwn(FRIENDLY_REMINDER_TYPES, channel)) {
    throw makeError(`Unsupported reminder channel: ${channel}`);
  }

  const match = /^([1-9]\d*)([mhd])$/i.exec(duration);
  if (!match) {
    throw makeError(`Invalid reminder duration: ${duration}`);
  }

  return {
    Type: FRIENDLY_REMINDER_TYPES[channel],
    Trigger: formatTrigger(Number(match[1]), match[2].toLowerCase()),
  };
}

function formatTrigger(amount, unit) {
  if (unit === "m") {
    return `-PT${amount}M`;
  }
  if (unit === "h") {
    return `-PT${amount}H`;
  }
  return `-P${amount}D`;
}
