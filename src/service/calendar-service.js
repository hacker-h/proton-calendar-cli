import { Temporal } from "@js-temporal/polyfill";
import { ApiError, isApiError } from "../errors.js";
import { normalizeFriendlyReminderFields } from "../reminders.js";

const ALLOWED_FIELDS = new Set([
  "title",
  "description",
  "start",
  "end",
  "allDay",
  "timezone",
  "location",
  "recurrence",
  "protected",
  "notifications",
]);

const MUTATION_SCOPES = new Set(["single", "following", "series"]);
const VALID_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const VALID_WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const VALID_DEFAULT_DURATIONS = new Set([30, 60, 90, 120]);
const METADATA_FIELDS = new Set(["name", "description", "color", "display"]);
const SETTINGS_FIELDS = new Set(["defaultCalendarId", "defaultDuration", "notifications"]);
const DEFAULT_RECURRENCE_MAX_ITERATIONS = 50000;
const EVENT_FETCH_PAGE_LIMIT = 50;
const EVENT_FETCH_PAGE_SIZE = 200;

export class CalendarService {
  constructor(options) {
    this.targetCalendarId = options.targetCalendarId || null;
    this.defaultCalendarId = options.defaultCalendarId || options.targetCalendarId || null;
    this.allowedCalendarIds = new Set(options.allowedCalendarIds || []);
    if (this.targetCalendarId) {
      this.allowedCalendarIds.add(this.targetCalendarId);
    }
    if (this.defaultCalendarId) {
      this.allowedCalendarIds.add(this.defaultCalendarId);
    }

    this.protonClient = options.protonClient;
    this.sessionStore = options.sessionStore;
    this.recurrenceMaxIterations = readPositiveNumber(options.recurrenceMaxIterations, DEFAULT_RECURRENCE_MAX_ITERATIONS);
  }

  async authStatus() {
    const session = await this.sessionStore.getSummary();
    try {
      const upstream = await this.protonClient.authStatus();
      return {
        authenticated: true,
        targetCalendarId: this.targetCalendarId,
        defaultCalendarId: this.defaultCalendarId,
        allowedCalendarIds: [...this.allowedCalendarIds].sort(),
        session,
        upstream,
      };
    } catch (error) {
      if (isApiError(error) && error.code === "AUTH_EXPIRED") {
        return {
          authenticated: false,
          targetCalendarId: this.targetCalendarId,
          defaultCalendarId: this.defaultCalendarId,
          allowedCalendarIds: [...this.allowedCalendarIds].sort(),
          session,
        };
      }
      throw error;
    }
  }

  async listCalendars() {
    const calendars = (await this.protonClient.listCalendars())
      .map((calendar) => ({
        id: String(calendar.id || calendar.calendarId || ""),
        name: String(calendar.name || calendar.id || calendar.calendarId || ""),
        description: calendar.description || "",
        color: calendar.color || null,
        display: calendar.display ?? null,
        permissions: calendar.permissions ?? null,
      }))
      .filter((calendar) => calendar.id)
      .filter((calendar) => this.allowedCalendarIds.size === 0 || this.allowedCalendarIds.has(calendar.id))
      .map((calendar) => ({
        ...calendar,
        default: calendar.id === this.defaultCalendarId,
        target: calendar.id === this.targetCalendarId,
        allowed: true,
      }));

    return {
      calendars,
      targetCalendarId: this.targetCalendarId,
      defaultCalendarId: this.defaultCalendarId,
      allowedCalendarIds: [...this.allowedCalendarIds].sort(),
    };
  }

  async getUserCalendarSettings() {
    return normalizeUserCalendarSettings(await this.protonClient.getUserCalendarSettings());
  }

  async updateUserCalendarSettings(payload) {
    const patch = validateUserCalendarSettingsPatch(payload);
    if (this.targetCalendarId) {
      throw new ApiError(400, "CALENDAR_SCOPE_VIOLATION", "calendar settings cannot be patched while target calendar hard-lock mode is active");
    }
    if (patch.defaultCalendarId !== undefined) {
      this.#assertAllowedCalendar(patch.defaultCalendarId);
    }
    return normalizeUserCalendarSettings(await this.protonClient.updateUserCalendarSettings(patch));
  }

  async getCalendarSettings(calendarId) {
    const resolvedCalendarId = this.#resolveCalendarId(calendarId, { allowDefault: false });
    return normalizeCalendarSettings(await this.protonClient.getCalendarSettings(resolvedCalendarId), resolvedCalendarId);
  }

  async updateCalendarSettings(calendarId, payload) {
    const resolvedCalendarId = this.#resolveCalendarId(calendarId, { allowDefault: false });
    const patch = validateCalendarSettingsPatch(payload);
    return normalizeCalendarSettings(await this.protonClient.updateCalendarSettings(resolvedCalendarId, patch), resolvedCalendarId);
  }

  async updateCalendarMetadata(calendarId, payload) {
    const resolvedCalendarId = this.#resolveCalendarId(calendarId, { allowDefault: false });
    const patch = validateCalendarMetadataPatch(payload);
    return normalizeCalendarMetadata(await this.protonClient.updateCalendarMetadata(resolvedCalendarId, patch), resolvedCalendarId);
  }

  async listEvents(input, options = {}) {
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });
    const range = validateRange(input.start, input.end);
    const limit = readLimit(input.limit);
    const offset = parseCursor(input.cursor);

    const expanded = await this.#listExpandedEventsInRange(calendarId, range);
    const page = expanded.slice(offset, offset + limit);
    const nextCursor = offset + limit < expanded.length ? String(offset + limit) : null;

    return {
      events: page,
      nextCursor,
    };
  }

  async listEventsForExport(input, options = {}) {
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });
    const range = validateRange(input.start, input.end);
    return {
      events: await this.#listExpandedEventsInRange(calendarId, range),
    };
  }

  async getEvent(eventId, options = {}) {
    ensureId(eventId);
    const parsedOccurrence = parseOccurrenceEventId(eventId);
    const effectiveEventId = parsedOccurrence ? parsedOccurrence.eventId : eventId;
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });

    const event = normalizeEvent(
      await this.protonClient.getEvent({
        calendarId,
        eventId: effectiveEventId,
      })
    );

    this.#assertExpectedCalendar(event, calendarId);

    if (!parsedOccurrence) {
      return event;
    }

    if (!event.recurrence) {
      throw new ApiError(404, "NOT_FOUND", "Occurrence not found");
    }

    const occurrence = materializeOccurrence(event, parsedOccurrence.occurrenceStart, {
      maxIterations: this.recurrenceMaxIterations,
    });
    if (!occurrence) {
      throw new ApiError(404, "NOT_FOUND", "Occurrence not found");
    }

    return occurrence;
  }

  async createEvent(payload, idempotencyKey, options = {}) {
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });
    assertCalendarPayload(payload, calendarId);
    const eventInput = validateCreatePayload(payload);

    const created = normalizeEvent(
      await this.protonClient.createEvent({
        calendarId,
        event: eventInput,
        idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
      })
    );

    this.#assertExpectedCalendar(created, calendarId);
    return created;
  }

  validateCreateEvents(payloads, options = {}) {
    if (!Array.isArray(payloads)) {
      throw new ApiError(400, "INVALID_PAYLOAD", "events must be an array");
    }
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });
    for (const payload of payloads) {
      assertCalendarPayload(payload, calendarId);
      validateCreatePayload(payload);
    }
  }

  async updateEvent(eventId, payload, idempotencyKey, options = {}) {
    ensureId(eventId);

    const parsedOccurrence = parseOccurrenceEventId(eventId);
    const effectiveEventId = parsedOccurrence ? parsedOccurrence.eventId : eventId;
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });
    assertCalendarPayload(payload, calendarId);

    const scope = normalizeScope(options.scope, parsedOccurrence ? "single" : "series");
    const occurrenceStart = normalizeOccurrenceStart(options.occurrenceStart || parsedOccurrence?.occurrenceStart, scope);
    const patch = validatePatchPayload(payload, scope);

    const updated = normalizeEvent(
      await this.protonClient.updateEvent({
        calendarId,
        eventId: effectiveEventId,
        patch,
        idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
        scope,
        occurrenceStart,
      })
    );

    this.#assertExpectedCalendar(updated, calendarId);
    return updated;
  }

  async deleteEvent(eventId, idempotencyKey, options = {}) {
    ensureId(eventId);

    const parsedOccurrence = parseOccurrenceEventId(eventId);
    const effectiveEventId = parsedOccurrence ? parsedOccurrence.eventId : eventId;
    const calendarId = this.#resolveCalendarId(options.calendarId, { allowDefault: true });

    const scope = normalizeScope(options.scope, parsedOccurrence ? "single" : "series");
    const occurrenceStart = normalizeOccurrenceStart(options.occurrenceStart || parsedOccurrence?.occurrenceStart, scope);

    await this.protonClient.deleteEvent({
      calendarId,
      eventId: effectiveEventId,
      idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
      scope,
      occurrenceStart,
    });

    return {
      deleted: true,
      eventId,
      scope,
      occurrenceStart,
    };
  }

  async #fetchAllEventsInRange(calendarId, range) {
    const rows = [];
    let cursor = null;
    let pages = 0;

    while (pages < EVENT_FETCH_PAGE_LIMIT) {
      const response = await this.protonClient.listEvents({
        calendarId,
        start: range.start,
        end: range.end,
        limit: EVENT_FETCH_PAGE_SIZE,
        cursor,
      });
      pages += 1;

      const events = Array.isArray(response?.events) ? response.events : [];
      rows.push(...events);

      const next = response?.nextCursor || null;
      if (!next) {
        return rows;
      }
      cursor = String(next);
    }

    throw new ApiError(422, "EVENT_LIST_PAGE_LIMIT", "Event listing exceeded the page limit", {
      calendarId,
      range,
      pageLimit: EVENT_FETCH_PAGE_LIMIT,
      pageSize: EVENT_FETCH_PAGE_SIZE,
      nextCursor: cursor,
    });
  }

  async #listExpandedEventsInRange(calendarId, range) {
    const rawEvents = await this.#fetchAllEventsInRange(calendarId, range);
    const normalized = rawEvents.map(normalizeEvent);
    const filtered = normalized.filter((event) => event.calendarId === calendarId);
    const expanded = expandEventsInRange(filtered, range.start, range.end, {
      maxIterations: this.recurrenceMaxIterations,
    });
    expanded.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return expanded;
  }

  #resolveCalendarId(calendarId, options = {}) {
    if (calendarId !== undefined && calendarId !== null && typeof calendarId !== "string") {
      throw new ApiError(400, "INVALID_PAYLOAD", "calendarId must be a string");
    }

    const requested = typeof calendarId === "string" ? calendarId.trim() : "";

    if (this.targetCalendarId) {
      if (requested && requested !== this.targetCalendarId) {
        throw new ApiError(400, "CALENDAR_SCOPE_VIOLATION", "calendarId cannot override target calendar");
      }
      return this.targetCalendarId;
    }

    if (requested) {
      this.#assertAllowedCalendar(requested);
      return requested;
    }

    if (options.allowDefault !== false && this.defaultCalendarId) {
      this.#assertAllowedCalendar(this.defaultCalendarId);
      return this.defaultCalendarId;
    }

    if (options.allowDefault !== false && this.allowedCalendarIds.size === 1) {
      const [single] = this.allowedCalendarIds;
      return single;
    }

    throw new ApiError(400, "CALENDAR_ID_REQUIRED", "calendarId is required for this request");
  }

  #assertAllowedCalendar(calendarId) {
    if (this.allowedCalendarIds.size > 0 && !this.allowedCalendarIds.has(calendarId)) {
      throw new ApiError(403, "CALENDAR_NOT_ALLOWED", "calendarId is not allowed", {
        calendarId,
      });
    }
  }

  #assertExpectedCalendar(event, expectedCalendarId) {
    if (event.calendarId !== expectedCalendarId) {
      throw new ApiError(502, "CALENDAR_SCOPE_VIOLATION", "Upstream returned data outside selected calendar", {
        expected: expectedCalendarId,
        received: event.calendarId,
      });
    }
  }
}

function assertCalendarPayload(payload, resolvedCalendarId) {
  if (payload && payload.calendarId !== undefined && typeof payload.calendarId !== "string") {
    throw new ApiError(400, "INVALID_PAYLOAD", "calendarId must be a string when provided");
  }
  if (payload?.calendarId && payload.calendarId !== resolvedCalendarId) {
    throw new ApiError(400, "CALENDAR_SCOPE_VIOLATION", "calendarId cannot override route or target calendar");
  }
}

function validateCreatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }
  payload = normalizeFriendlyReminderFields(payload, invalidReminderError);

  const title = requireString(payload.title, "title", 1, 200);
  const timezone = requireString(payload.timezone, "timezone", 1, 100);
  const allDay = readBoolean(payload.allDay, "allDay", false);
  const start = requireDate(payload.start, "start", { allDay, timezone });
  const end = requireDate(payload.end, "end", { allDay, timezone });

  if (Date.parse(end) <= Date.parse(start)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "end must be after start");
  }

  if (payload.protected !== undefined && typeof payload.protected !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "protected must be a boolean");
  }
  const protected_ = typeof payload.protected === "boolean" ? payload.protected : true;

  return {
    title,
    description: optionalString(payload.description, "description", 0, 4000),
    start,
    end,
    allDay,
    timezone,
    location: optionalString(payload.location, "location", 0, 400),
    recurrence: payload.recurrence === undefined ? null : validateRecurrence(payload.recurrence),
    protected: protected_,
    notifications: payload.notifications === undefined ? null : validateNotifications(payload.notifications),
  };
}

function validatePatchPayload(payload, scope) {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }
  payload = normalizeFriendlyReminderFields(payload, invalidReminderError);

  const patch = {};
  const patchTimezone = payload.timezone === undefined ? undefined : requireString(payload.timezone, "timezone", 1, 100);
  const patchAllDay = payload.allDay === undefined ? undefined : readBoolean(payload.allDay, "allDay", false);
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_FIELDS.has(key) && key !== "calendarId") {
      throw new ApiError(400, "INVALID_FIELD", `Unsupported field: ${key}`);
    }
    if (key === "calendarId") {
      continue;
    }

    if (key === "start" || key === "end") {
      patch[key] = requireDate(value, key, {
        allDay: patchAllDay === true,
        timezone: patchTimezone || "UTC",
      });
      continue;
    }
    if (key === "title") {
      patch[key] = requireString(value, key, 1, 200);
      continue;
    }
    if (key === "timezone") {
      patch[key] = patchTimezone;
      continue;
    }
    if (key === "description") {
      patch[key] = optionalString(value, key, 0, 4000);
      continue;
    }
    if (key === "location") {
      patch[key] = optionalString(value, key, 0, 400);
      continue;
    }
    if (key === "recurrence") {
      if (scope === "single") {
        throw new ApiError(400, "INVALID_SCOPE", "recurrence cannot be changed for scope=single");
      }
      patch.recurrence = value === null ? null : validateRecurrence(value);
      continue;
    }
    if (key === "protected") {
      if (typeof value !== "boolean") {
        throw new ApiError(400, "INVALID_FIELD", "protected must be a boolean");
      }
      patch.protected = value;
      continue;
    }
    if (key === "notifications") {
      patch.notifications = validateNotifications(value);
      continue;
    }
    if (key === "allDay") {
      patch.allDay = patchAllDay;
      continue;
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "EMPTY_PATCH", "At least one mutable field is required");
  }

  if (patch.start && patch.end && Date.parse(patch.end) <= Date.parse(patch.start)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "end must be after start");
  }

  return patch;
}

function validateUserCalendarSettingsPatch(payload) {
  const patch = validateSettingsPatch(payload, { allowDefaultCalendar: true });
  if (patch.defaultCalendarId !== undefined) {
    patch.defaultCalendarId = requireString(patch.defaultCalendarId, "defaultCalendarId", 1, 300);
  }
  return patch;
}

function validateCalendarSettingsPatch(payload) {
  return validateSettingsPatch(payload, { allowDefaultCalendar: false });
}

function validateSettingsPatch(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }
  const patch = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SETTINGS_FIELDS.has(key)) {
      throw new ApiError(400, "INVALID_FIELD", `Unsupported field: ${key}`);
    }
    if (key === "defaultCalendarId") {
      if (!options.allowDefaultCalendar) {
        throw new ApiError(400, "INVALID_FIELD", "defaultCalendarId is only supported for user calendar settings");
      }
      patch.defaultCalendarId = value;
      continue;
    }
    if (key === "defaultDuration") {
      patch.defaultDuration = validateDefaultDuration(value);
      continue;
    }
    if (key === "notifications") {
      patch.notifications = validateSettingsNotifications(value);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "EMPTY_PATCH", "At least one mutable field is required");
  }
  return patch;
}

function validateCalendarMetadataPatch(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }
  const patch = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!METADATA_FIELDS.has(key)) {
      throw new ApiError(400, "INVALID_FIELD", `Unsupported field: ${key}`);
    }
    if (key === "name") {
      patch.name = requireString(value, "name", 1, 200);
      continue;
    }
    if (key === "description") {
      patch.description = optionalString(value, "description", 0, 4000);
      continue;
    }
    if (key === "color") {
      patch.color = validateColor(value);
      continue;
    }
    if (key === "display") {
      patch.display = validateDisplay(value);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "EMPTY_PATCH", "At least one mutable field is required");
  }
  return patch;
}

function validateDefaultDuration(value) {
  const duration = Number(value);
  if (!Number.isInteger(duration) || !VALID_DEFAULT_DURATIONS.has(duration)) {
    throw new ApiError(400, "INVALID_FIELD", "defaultDuration must be one of 30, 60, 90, or 120");
  }
  return duration;
}

function validateColor(value) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    throw new ApiError(400, "INVALID_FIELD", "color must be #RRGGBB");
  }
  return value.trim().toUpperCase();
}

function validateDisplay(value) {
  const display = Number(value);
  if (!Number.isInteger(display) || ![0, 1].includes(display)) {
    throw new ApiError(400, "INVALID_FIELD", "display must be 0 or 1");
  }
  return display;
}

function validateSettingsNotifications(raw) {
  if (raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_NOTIFICATIONS", "notifications must be null or an array");
  }
  if (raw.length > 10) {
    throw new ApiError(400, "INVALID_NOTIFICATIONS", "notifications cannot contain more than 10 entries");
  }
  return raw.map((notification, index) => {
    if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
      throw new ApiError(400, "INVALID_NOTIFICATIONS", `notifications[${index}] must be an object`);
    }
    const type = notification.type ?? notification.Type;
    const trigger = notification.trigger ?? notification.Trigger;
    if (!Number.isInteger(Number(type))) {
      throw new ApiError(400, "INVALID_NOTIFICATIONS", `notifications[${index}].type must be an integer`);
    }
    if (typeof trigger !== "string" || trigger.trim() === "") {
      throw new ApiError(400, "INVALID_NOTIFICATIONS", `notifications[${index}].trigger must be a string`);
    }
    return { type: Number(type), trigger: trigger.trim() };
  });
}

function normalizeUserCalendarSettings(settings) {
  return {
    defaultCalendarId: settings?.defaultCalendarId || null,
    defaultDuration: settings?.defaultDuration ?? null,
    notifications: normalizeSettingsNotifications(settings?.notifications),
    raw: clonePlainObject(settings?.raw),
  };
}

function normalizeCalendarSettings(settings, calendarId) {
  return {
    calendarId: settings?.calendarId || calendarId,
    defaultDuration: settings?.defaultDuration ?? null,
    notifications: normalizeSettingsNotifications(settings?.notifications),
    raw: clonePlainObject(settings?.raw),
  };
}

function normalizeCalendarMetadata(metadata, calendarId) {
  return {
    calendarId: metadata?.calendarId || calendarId,
    name: metadata?.name || null,
    description: metadata?.description || "",
    color: metadata?.color || null,
    display: metadata?.display ?? null,
    raw: clonePlainObject(metadata?.raw),
  };
}

function normalizeSettingsNotifications(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new ApiError(502, "UPSTREAM_INVALID_SETTINGS", "Upstream notifications payload is invalid");
  }
  return value.map((notification) => ({
    type: Number(notification.type ?? notification.Type),
    trigger: String(notification.trigger ?? notification.Trigger),
  }));
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function invalidReminderError(message) {
  return new ApiError(400, "INVALID_REMINDERS", message);
}

function validateRecurrence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence must be an object");
  }

  const freq = requireString(raw.freq, "recurrence.freq", 2, 10).toUpperCase();
  if (!VALID_FREQ.has(freq)) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.freq must be DAILY, WEEKLY, MONTHLY, or YEARLY");
  }

  const interval = readPositiveInt(raw.interval, "recurrence.interval", 1);
  const count = raw.count === undefined || raw.count === null ? null : readPositiveInt(raw.count, "recurrence.count", null);
  const until = raw.until === undefined || raw.until === null ? null : requireDate(raw.until, "recurrence.until");

  if (count !== null && until !== null) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.count and recurrence.until cannot both be set");
  }

  const byDay = normalizeByDay(raw.byDay);
  const byMonthDay = normalizeByMonthDay(raw.byMonthDay);
  const weekStart = raw.weekStart === undefined || raw.weekStart === null ? null : normalizeWeekday(raw.weekStart, "recurrence.weekStart");
  const exDates = normalizeExDates(raw.exDates);

  if (freq === "WEEKLY" && byDay.some((day) => parseByDayToken(day).ordinal !== null)) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay must use plain weekdays for WEEKLY frequency");
  }

  if (freq === "MONTHLY" && byDay.some((day) => {
    const { ordinal } = parseByDayToken(day);
    return ordinal !== null && Math.abs(ordinal) > 5;
  })) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay monthly ordinals must be between 1 and 5");
  }

  if (freq !== "WEEKLY" && freq !== "MONTHLY" && byDay.length > 0) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay is only supported for WEEKLY or MONTHLY frequency");
  }

  if (freq !== "MONTHLY" && byMonthDay.length > 0) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byMonthDay is only supported for MONTHLY frequency");
  }

  if (freq === "MONTHLY" && byDay.length > 0 && byMonthDay.length > 0 && !monthlyByDayCanMatchMonthDay(byDay, byMonthDay)) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay and recurrence.byMonthDay cannot produce any monthly dates");
  }

  return {
    freq,
    interval,
    count,
    until,
    byDay,
    byMonthDay,
    weekStart,
    exDates,
  };
}

function validateNotifications(raw) {
  if (raw === null) {
    return null;
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "INVALID_NOTIFICATIONS", "notifications must be null or an array");
  }
  if (raw.length > 10) {
    throw new ApiError(400, "INVALID_NOTIFICATIONS", "notifications cannot contain more than 10 entries");
  }

  return raw.map((notification, index) => {
    if (!notification || typeof notification !== "object" || Array.isArray(notification)) {
      throw new ApiError(400, "INVALID_NOTIFICATIONS", `notifications[${index}] must be an object`);
    }
    return cloneJsonObject(notification, `notifications[${index}]`);
  });
}

function cloneJsonObject(value, field) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new ApiError(400, "INVALID_NOTIFICATIONS", `${field} must be JSON-serializable`);
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream event payload is invalid");
  }

  let recurrence;
  let notifications;
  try {
    recurrence = normalizeIncomingRecurrence(event.recurrence ?? event.rrule ?? null);
  } catch {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream recurrence payload is invalid");
  }
  try {
    notifications = normalizeIncomingNotifications(event.notifications);
  } catch {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream notifications payload is invalid");
  }

  const occurrenceStart = event.occurrenceStart || event.recurrenceId || null;
  const seriesId = event.seriesId || event.series_id || event.parentId || null;

  const normalized = {
    id: String(event.id || event.eventId || event.uid || ""),
    calendarId: String(event.calendarId || event.calendarID || event.calendar_id || ""),
    title: String(event.title || ""),
    description: event.description ? String(event.description) : "",
    start: String(event.start || event.startAt || event.start_time || ""),
    end: String(event.end || event.endAt || event.end_time || ""),
    allDay: Boolean(event.allDay ?? event.isAllDay ?? false),
    timezone: String(event.timezone || event.tz || "UTC"),
    location: event.location ? String(event.location) : "",
    protected: typeof event.protected === "boolean" ? event.protected : false,
    recurrence,
    seriesId: seriesId ? String(seriesId) : null,
    occurrenceStart: occurrenceStart ? requireDate(occurrenceStart, "occurrenceStart") : null,
    isRecurring: Boolean(recurrence || seriesId || occurrenceStart),
    createdAt: event.createdAt || event.created_at || null,
    updatedAt: event.updatedAt || event.updated_at || null,
    notifications,
  };

  if (!normalized.id || !normalized.calendarId || !normalized.title || !normalized.start || !normalized.end) {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream event payload missing required fields");
  }

  if (Date.parse(normalized.end) <= Date.parse(normalized.start)) {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream event payload has invalid time range");
  }

  return normalized;
}

function normalizeIncomingNotifications(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("invalid notifications");
  }
  return value.map((item) => cloneJsonObject(item, "notifications"));
}

function normalizeIncomingRecurrence(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    return parseRRule(value);
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid recurrence");
  }

  const normalized = validateRecurrence(value);
  return {
    ...normalized,
    exDates: normalizeExDates(value.exDates),
  };
}

function normalizeScope(scopeRaw, fallback) {
  if (scopeRaw === undefined || scopeRaw === null || String(scopeRaw).trim() === "") {
    return fallback;
  }

  const scope = String(scopeRaw).trim().toLowerCase();
  if (!MUTATION_SCOPES.has(scope)) {
    throw new ApiError(400, "INVALID_SCOPE", "scope must be single, following, or series");
  }
  return scope;
}

function normalizeOccurrenceStart(raw, scope) {
  if (scope === "series") {
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return null;
    }
    return requireDate(String(raw), "occurrenceStart");
  }

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new ApiError(400, "OCCURRENCE_START_REQUIRED", "occurrenceStart is required for scope=single/following");
  }

  return requireDate(String(raw), "occurrenceStart");
}

function parseOccurrenceEventId(eventId) {
  const marker = "::";
  const index = eventId.lastIndexOf(marker);
  if (index === -1) {
    return null;
  }

  const base = eventId.slice(0, index);
  const encodedOccurrence = eventId.slice(index + marker.length);
  if (!base || !encodedOccurrence) {
    throw new ApiError(400, "INVALID_OCCURRENCE_ID", "Occurrence event id is invalid");
  }

  let decoded;
  try {
    decoded = decodeURIComponent(encodedOccurrence);
  } catch {
    throw new ApiError(400, "INVALID_OCCURRENCE_ID", "Occurrence event id is invalid");
  }

  let occurrenceStart;
  try {
    occurrenceStart = requireDate(decoded, "occurrenceStart");
  } catch {
    throw new ApiError(400, "INVALID_OCCURRENCE_ID", "Occurrence event id is invalid");
  }
  return {
    eventId: base,
    occurrenceStart,
  };
}

function buildOccurrenceEventId(eventId, occurrenceStart) {
  return `${eventId}::${encodeURIComponent(occurrenceStart)}`;
}

function materializeOccurrence(seriesEvent, occurrenceStart, options = {}) {
  const durationMs = Date.parse(seriesEvent.end) - Date.parse(seriesEvent.start);
  const matches = generateOccurrences(seriesEvent, occurrenceStart, new Date(Date.parse(occurrenceStart) + 1).toISOString(), options);
  if (matches.length === 0) {
    return null;
  }

  const start = matches[0];
  return {
    ...seriesEvent,
    id: buildOccurrenceEventId(seriesEvent.id, start),
    start,
    end: new Date(Date.parse(start) + durationMs).toISOString(),
    occurrenceStart: start,
    seriesId: seriesEvent.id,
    isRecurring: true,
  };
}

function expandEventsInRange(events, rangeStart, rangeEnd, options = {}) {
  const expanded = [];
  const detachedKeys = new Set();

  for (const event of events) {
    if (event.recurrence) {
      continue;
    }

    if (!isWithinRange(event.start, rangeStart, rangeEnd)) {
      continue;
    }

    expanded.push(event);
    if (event.seriesId && event.occurrenceStart) {
      detachedKeys.add(buildDetachedKey(event.seriesId, event.occurrenceStart));
    }
  }

  for (const event of events) {
    if (!event.recurrence) {
      continue;
    }

    const durationMs = Date.parse(event.end) - Date.parse(event.start);
    const starts = generateOccurrences(event, rangeStart, rangeEnd, options);
    for (const start of starts) {
      const detachedKey = buildDetachedKey(event.id, start);
      if (detachedKeys.has(detachedKey)) {
        continue;
      }

      expanded.push({
        ...event,
        id: buildOccurrenceEventId(event.id, start),
        start,
        end: new Date(Date.parse(start) + durationMs).toISOString(),
        occurrenceStart: start,
        seriesId: event.id,
        isRecurring: true,
      });
    }
  }

  return expanded;
}

function generateOccurrences(event, rangeStart, rangeEnd, options = {}) {
  if (!event.recurrence) {
    return [];
  }

  const recurrence = event.recurrence;
  const startDate = new Date(event.start);
  const rangeStartMs = Date.parse(rangeStart);
  const rangeEndMs = Date.parse(rangeEnd);
  const untilMs = recurrence.until ? Date.parse(recurrence.until) : Number.POSITIVE_INFINITY;
  const countLimit = recurrence.count ?? Number.POSITIVE_INFINITY;
  const exDateSet = new Set((recurrence.exDates || []).map((value) => new Date(value).toISOString()));

  const results = [];
  let generatedCount = 0;
  let emitted = 0;
  const maxIterations = readPositiveNumber(options.maxIterations, DEFAULT_RECURRENCE_MAX_ITERATIONS);

  const candidates = shouldUseZonedRecurrence(event)
    ? iterateZonedRecurrenceCandidates(event.start, event.timezone, recurrence)
    : iterateRecurrenceCandidates(startDate, recurrence);

  for (const candidate of candidates) {
    if (emitted >= countLimit) {
      break;
    }

    if (generatedCount >= maxIterations) {
      throw new ApiError(422, "RECURRENCE_ITERATION_LIMIT", "Recurrence expansion exceeded the candidate iteration limit", {
        maxIterations,
      });
    }

    const candidateIso = candidate.toISOString();
    const candidateMs = Date.parse(candidateIso);
    generatedCount += 1;

    if (candidateMs > untilMs) {
      break;
    }

    if (candidateMs >= rangeEndMs) {
      break;
    }

    if (exDateSet.has(candidateIso)) {
      continue;
    }

    emitted += 1;

    if (candidateMs >= rangeStartMs && candidateMs < rangeEndMs) {
      results.push(candidateIso);
    }
  }

  return results;
}

function* iterateRecurrenceCandidates(startDate, recurrence) {
  if (recurrence.freq === "DAILY") {
    let cursor = new Date(startDate);
    while (true) {
      yield new Date(cursor);
      cursor = addDays(cursor, recurrence.interval);
    }
  }

  if (recurrence.freq === "WEEKLY") {
    const weekStart = weekdayToIndex(recurrence.weekStart || "MO");
    const baseWeekStart = startOfWeek(startDate, weekStart);
    const time = pickUtcTime(startDate);
    const byDay = recurrence.byDay.length > 0 ? recurrence.byDay : [indexToWeekday(startDate.getUTCDay())];
    const dayOffsets = byDay
      .map((day) => {
        const idx = weekdayToIndex(day);
        return (idx - weekStart + 7) % 7;
      })
      .sort((a, b) => a - b);

    let weekOffset = 0;
    while (true) {
      const thisWeekStart = addDays(baseWeekStart, weekOffset * recurrence.interval * 7);
      for (const offset of dayOffsets) {
        const day = addDays(thisWeekStart, offset);
        const candidate = withUtcTime(day, time);
        if (candidate < startDate) {
          continue;
        }
        yield candidate;
      }
      weekOffset += 1;
    }
  }

  if (recurrence.freq === "MONTHLY") {
    const time = pickUtcTime(startDate);
    let monthOffset = 0;

    while (true) {
      const monthDate = addMonthsUtc(startDate, monthOffset * recurrence.interval);
      const year = monthDate.getUTCFullYear();
      const month = monthDate.getUTCMonth();

      if (recurrence.byDay.length > 0) {
        const candidates = monthlyByDayCandidates(year, month, recurrence.byDay, recurrence.byMonthDay, time);

        for (const candidate of candidates) {
          if (candidate < startDate) {
            continue;
          }
          yield candidate;
        }

        monthOffset += 1;
        continue;
      }

      const byMonthDay = recurrence.byMonthDay.length > 0 ? recurrence.byMonthDay : [startDate.getUTCDate()];
      const maxDay = daysInMonthUtc(year, month);
      const days = effectiveMonthDays(byMonthDay, maxDay);
      for (const dayOfMonth of days) {
        const candidate = withUtcTime(new Date(Date.UTC(year, month, dayOfMonth)), time);
        if (candidate < startDate) {
          continue;
        }
        yield candidate;
      }

      monthOffset += 1;
    }
  }

  if (recurrence.freq === "YEARLY") {
    const month = startDate.getUTCMonth();
    const day = startDate.getUTCDate();
    const time = pickUtcTime(startDate);

    let yearOffset = 0;
    while (true) {
      const year = startDate.getUTCFullYear() + yearOffset * recurrence.interval;
      const maxDay = daysInMonthUtc(year, month);
      if (day <= maxDay) {
        const candidate = withUtcTime(new Date(Date.UTC(year, month, day)), time);
        if (candidate >= startDate) {
          yield candidate;
        }
      }
      yearOffset += 1;
    }
  }
}

function* iterateZonedRecurrenceCandidates(startIso, timezone, recurrence) {
  const start = toZonedDateTime(startIso, timezone);
  const startInstant = start.toInstant();

  if (recurrence.freq === "DAILY") {
    let cursor = start;
    while (true) {
      yield zonedDateTimeToDate(cursor);
      cursor = cursor.add({ days: recurrence.interval });
    }
  }

  if (recurrence.freq === "WEEKLY") {
    const weekStart = weekdayToIndex(recurrence.weekStart || "MO");
    const startWeekday = temporalDayToWeekdayIndex(start.dayOfWeek);
    const baseWeekStart = start.toPlainDate().subtract({ days: (startWeekday - weekStart + 7) % 7 });
    const time = pickZonedTime(start);
    const byDay = recurrence.byDay.length > 0 ? recurrence.byDay : [indexToWeekday(startWeekday)];
    const dayOffsets = byDay
      .map((day) => {
        const idx = weekdayToIndex(day);
        return (idx - weekStart + 7) % 7;
      })
      .sort((a, b) => a - b);

    let weekOffset = 0;
    while (true) {
      const thisWeekStart = baseWeekStart.add({ days: weekOffset * recurrence.interval * 7 });
      for (const offset of dayOffsets) {
        const candidate = zonedFromPlainDate(thisWeekStart.add({ days: offset }), time, timezone);
        if (Temporal.Instant.compare(candidate.toInstant(), startInstant) < 0) {
          continue;
        }
        yield zonedDateTimeToDate(candidate);
      }
      weekOffset += 1;
    }
  }

  if (recurrence.freq === "MONTHLY") {
    const time = pickZonedTime(start);
    const startMonth = Temporal.PlainDate.from({ year: start.year, month: start.month, day: 1 });
    let monthOffset = 0;

    while (true) {
      const monthDate = startMonth.add({ months: monthOffset * recurrence.interval });

      if (recurrence.byDay.length > 0) {
        const candidates = monthlyByDayCandidatesZoned(
          monthDate.year,
          monthDate.month,
          recurrence.byDay,
          recurrence.byMonthDay,
          time,
          timezone
        );

        for (const candidate of candidates) {
          if (Temporal.Instant.compare(candidate.toInstant(), startInstant) < 0) {
            continue;
          }
          yield zonedDateTimeToDate(candidate);
        }

        monthOffset += 1;
        continue;
      }

      const byMonthDay = recurrence.byMonthDay.length > 0 ? recurrence.byMonthDay : [start.day];
      const days = effectiveMonthDays(byMonthDay, daysInMonthZoned(monthDate.year, monthDate.month));
      for (const dayOfMonth of days) {
        const candidate = zonedFromPlainDate(
          Temporal.PlainDate.from({ year: monthDate.year, month: monthDate.month, day: dayOfMonth }),
          time,
          timezone
        );
        if (Temporal.Instant.compare(candidate.toInstant(), startInstant) < 0) {
          continue;
        }
        yield zonedDateTimeToDate(candidate);
      }

      monthOffset += 1;
    }
  }

  if (recurrence.freq === "YEARLY") {
    const month = start.month;
    const day = start.day;
    const time = pickZonedTime(start);

    let yearOffset = 0;
    while (true) {
      const year = start.year + yearOffset * recurrence.interval;
      if (day <= daysInMonthZoned(year, month)) {
        const candidate = zonedFromPlainDate(Temporal.PlainDate.from({ year, month, day }), time, timezone);
        if (Temporal.Instant.compare(candidate.toInstant(), startInstant) >= 0) {
          yield zonedDateTimeToDate(candidate);
        }
      }
      yearOffset += 1;
    }
  }
}

function buildDetachedKey(seriesId, occurrenceStart) {
  return `${seriesId}::${occurrenceStart}`;
}

function parseRRule(rrule) {
  if (typeof rrule !== "string" || rrule.trim() === "") {
    throw new ApiError(400, "INVALID_RECURRENCE", "Invalid rrule");
  }

  const parts = {};
  const rule = rrule.trim().replace(/^RRULE:/i, "");
  for (const pair of rule.split(";")) {
    const [keyRaw, valueRaw] = pair.split("=");
    const key = String(keyRaw || "").trim().toUpperCase();
    const value = String(valueRaw || "").trim();
    if (!key || !value) {
      continue;
    }
    parts[key] = value;
  }

  const recurrence = {
    freq: parts.FREQ,
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    count: parts.COUNT ? Number(parts.COUNT) : null,
    until: parts.UNTIL ? parseRruleUntil(parts.UNTIL) : null,
    byDay: parts.BYDAY ? parts.BYDAY.split(",").map((v) => v.trim()) : [],
    byMonthDay: parts.BYMONTHDAY
      ? parts.BYMONTHDAY
          .split(",")
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isInteger(n))
      : [],
    weekStart: parts.WKST || null,
    exDates: [],
  };

  return validateRecurrence(recurrence);
}

function parseRruleUntil(value) {
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(4, 6)) - 1;
    const day = Number(value.slice(6, 8));
    const hour = Number(value.slice(9, 11));
    const minute = Number(value.slice(11, 13));
    const second = Number(value.slice(13, 15));
    return new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString();
  }
  return requireDate(value, "recurrence.until");
}

function validateRange(startRaw, endRaw) {
  const start = requireDate(startRaw, "start");
  const end = requireDate(endRaw, "end");
  if (Date.parse(end) <= Date.parse(start)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "end must be after start");
  }
  return { start, end };
}

function readLimit(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return 50;
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ApiError(400, "INVALID_LIMIT", "limit must be an integer between 1 and 200");
  }
  return limit;
}

function parseCursor(rawCursor) {
  const parsed = Number(rawCursor || "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function ensureId(id) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new ApiError(400, "INVALID_ID", "Event id is required");
  }
}

function requireString(value, field, minLen, maxLen) {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} length must be between ${minLen} and ${maxLen}`);
  }
  return trimmed;
}

function optionalString(value, field, minLen, maxLen) {
  if (value === undefined || value === null) {
    return "";
  }
  return requireString(value, field, minLen, maxLen);
}

function requireDate(value, field, options = {}) {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} must be an ISO date-time string`);
  }

  if (options.allDay && isDateOnlyString(value)) {
    return parseDateOnlyInTimeZone(value, options.timezone || "UTC");
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} must be an ISO date-time string`);
  }
  return new Date(parsed).toISOString();
}

function readBoolean(value, field, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", `${field} must be a boolean`);
  }
  return value;
}

function isDateOnlyString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function parseDateOnlyInTimeZone(value, timezone) {
  const [year, month, day] = String(value).trim().split("-").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const resolved = new Date(utcGuess.getTime() - getTimeZoneOffsetMs(utcGuess, timezone));
  return resolved.toISOString();
}

function getTimeZoneOffsetMs(date, timezone) {
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
  const parts = formatter.formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asUtc - date.getTime();
}

function normalizeIdempotencyKey(value) {
  if (Array.isArray(value)) {
    return value[0] || undefined;
  }
  return value;
}

function readPositiveInt(raw, field, fallback) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ApiError(400, "INVALID_RECURRENCE", `${field} must be a positive integer`);
  }
  return num;
}

function readPositiveNumber(raw, fallback) {
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return num;
  }
  return fallback;
}

function normalizeByDay(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }

  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const unique = new Set();
  for (const value of values) {
    const token = parseByDayToken(value);
    unique.add(token.normalized);
  }
  return [...unique];
}

function parseByDayToken(raw) {
  if (typeof raw !== "string") {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay must contain weekday values");
  }

  const match = raw.trim().toUpperCase().match(/^([+-]?)(\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
  if (!match || (match[1] && !match[2])) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay must contain weekday values like MO,+1MO,2TU,-1FR");
  }

  const [, sign, ordinalRaw, weekday] = match;
  if (!ordinalRaw) {
    return { ordinal: null, weekday, normalized: weekday };
  }

  const magnitude = Number(ordinalRaw);
  if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 53) {
    throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byDay ordinals must be between 1 and 53");
  }

  const ordinal = sign === "-" ? -magnitude : magnitude;
  return {
    ordinal,
    weekday,
    normalized: `${sign}${magnitude}${weekday}`,
  };
}

function monthlyByDayCanMatchMonthDay(byDay, byMonthDay) {
  return byDay.some((token) => {
    const { ordinal } = parseByDayToken(token);
    if (ordinal === null) {
      return true;
    }
    return byMonthDay.some((dayOfMonth) => ordinalCanMatchMonthDay(ordinal, dayOfMonth));
  });
}

function ordinalCanMatchMonthDay(ordinal, dayOfMonth) {
  if (ordinal > 0) {
    return dayOfMonth >= 1 + (ordinal - 1) * 7 && dayOfMonth <= ordinal * 7;
  }

  const magnitude = Math.abs(ordinal);
  const minDay = Math.max(1, 28 - (magnitude * 7 - 1));
  const maxDay = 31 - (magnitude - 1) * 7;
  return dayOfMonth >= minDay && dayOfMonth <= maxDay;
}

function normalizeByMonthDay(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }

  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const unique = new Set();
  for (const value of values) {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > 31) {
      throw new ApiError(400, "INVALID_RECURRENCE", "recurrence.byMonthDay must contain values 1..31");
    }
    unique.add(num);
  }

  return [...unique];
}

function normalizeExDates(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return [];
  }

  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const unique = new Set();
  for (const value of values) {
    unique.add(requireDate(String(value), "recurrence.exDates"));
  }
  return [...unique].sort();
}

function normalizeWeekday(raw, field) {
  if (typeof raw !== "string") {
    throw new ApiError(400, "INVALID_RECURRENCE", `${field} must contain weekday values`);
  }

  const upper = raw.trim().toUpperCase();
  if (!VALID_WEEKDAYS.has(upper)) {
    throw new ApiError(400, "INVALID_RECURRENCE", `${field} must contain weekday values like MO,TU,...`);
  }
  return upper;
}

function weekdayToIndex(day) {
  const normalized = normalizeWeekday(day, "weekday");
  const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return order.indexOf(normalized);
}

function indexToWeekday(index) {
  const order = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return order[((index % 7) + 7) % 7];
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMonthsUtc(date, deltaMonths) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + deltaMonths;
  const day = date.getUTCDate();

  const first = new Date(Date.UTC(year, month, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const maxDay = daysInMonthUtc(first.getUTCFullYear(), first.getUTCMonth());
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, maxDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

function daysInMonthUtc(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function effectiveMonthDays(days, maxDay) {
  return [...new Set(days.map((day) => Math.min(day, maxDay)))].sort((a, b) => a - b);
}

function monthlyByDayCandidates(year, month, byDay, byMonthDay, time) {
  const candidates = new Map();
  const maxDay = daysInMonthUtc(year, month);
  const allowedMonthDays = byMonthDay.length > 0 ? new Set(effectiveMonthDays(byMonthDay, maxDay)) : null;

  for (const token of byDay) {
    const { ordinal, weekday } = parseByDayToken(token);
    if (ordinal !== null) {
      const date = nthWeekdayOfMonth(year, month, weekday, ordinal);
      if (date && (!allowedMonthDays || allowedMonthDays.has(date.getUTCDate()))) {
        const candidate = withUtcTime(date, time);
        candidates.set(candidate.toISOString(), candidate);
      }
      continue;
    }

    const weekdayIndex = weekdayToIndex(weekday);
    for (let dayOfMonth = 1; dayOfMonth <= maxDay; dayOfMonth += 1) {
      if (allowedMonthDays && !allowedMonthDays.has(dayOfMonth)) {
        continue;
      }
      const date = new Date(Date.UTC(year, month, dayOfMonth));
      if (date.getUTCDay() === weekdayIndex) {
        const candidate = withUtcTime(date, time);
        candidates.set(candidate.toISOString(), candidate);
      }
    }
  }

  return [...candidates.values()].sort((a, b) => a - b);
}

function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  const weekdayIndex = weekdayToIndex(weekday);
  const maxDay = daysInMonthUtc(year, month);

  if (ordinal > 0) {
    const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const firstMatchingDay = 1 + ((weekdayIndex - firstWeekday + 7) % 7);
    const dayOfMonth = firstMatchingDay + (ordinal - 1) * 7;
    return dayOfMonth <= maxDay ? new Date(Date.UTC(year, month, dayOfMonth)) : null;
  }

  const lastWeekday = new Date(Date.UTC(year, month, maxDay)).getUTCDay();
  const lastMatchingDay = maxDay - ((lastWeekday - weekdayIndex + 7) % 7);
  const dayOfMonth = lastMatchingDay + (ordinal + 1) * 7;
  return dayOfMonth >= 1 ? new Date(Date.UTC(year, month, dayOfMonth)) : null;
}

function shouldUseZonedRecurrence(event) {
  return !event.allDay && isSupportedIanaTimeZone(event.timezone) && !isUtcTimeZone(event.timezone);
}

function isUtcTimeZone(timezone) {
  return String(timezone || "").toUpperCase() === "UTC";
}

function isSupportedIanaTimeZone(timezone) {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function toZonedDateTime(iso, timezone) {
  return Temporal.Instant.from(iso).toZonedDateTimeISO(timezone);
}

function zonedDateTimeToDate(zonedDateTime) {
  return new Date(zonedDateTime.toInstant().toString());
}

function pickZonedTime(zonedDateTime) {
  return {
    hour: zonedDateTime.hour,
    minute: zonedDateTime.minute,
    second: zonedDateTime.second,
    millisecond: zonedDateTime.millisecond,
  };
}

function zonedFromPlainDate(date, time, timezone) {
  return Temporal.ZonedDateTime.from(
    {
      timeZone: timezone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: time.hour,
      minute: time.minute,
      second: time.second,
      millisecond: time.millisecond,
    },
    { disambiguation: "compatible", overflow: "reject" }
  );
}

function temporalDayToWeekdayIndex(dayOfWeek) {
  return dayOfWeek % 7;
}

function daysInMonthZoned(year, month) {
  return Temporal.PlainDate.from({ year, month, day: 1 }).daysInMonth;
}

function monthlyByDayCandidatesZoned(year, month, byDay, byMonthDay, time, timezone) {
  const candidates = new Map();
  const maxDay = daysInMonthZoned(year, month);
  const allowedMonthDays = byMonthDay.length > 0 ? new Set(effectiveMonthDays(byMonthDay, maxDay)) : null;

  for (const token of byDay) {
    const { ordinal, weekday } = parseByDayToken(token);
    if (ordinal !== null) {
      const date = nthWeekdayOfMonthZoned(year, month, weekday, ordinal);
      if (date && (!allowedMonthDays || allowedMonthDays.has(date.day))) {
        const candidate = zonedFromPlainDate(date, time, timezone);
        candidates.set(candidate.toInstant().toString(), candidate);
      }
      continue;
    }

    const weekdayIndex = weekdayToIndex(weekday);
    for (let dayOfMonth = 1; dayOfMonth <= maxDay; dayOfMonth += 1) {
      if (allowedMonthDays && !allowedMonthDays.has(dayOfMonth)) {
        continue;
      }
      const date = Temporal.PlainDate.from({ year, month, day: dayOfMonth });
      if (temporalDayToWeekdayIndex(date.dayOfWeek) === weekdayIndex) {
        const candidate = zonedFromPlainDate(date, time, timezone);
        candidates.set(candidate.toInstant().toString(), candidate);
      }
    }
  }

  return [...candidates.values()].sort((a, b) => Temporal.Instant.compare(a.toInstant(), b.toInstant()));
}

function nthWeekdayOfMonthZoned(year, month, weekday, ordinal) {
  const weekdayIndex = weekdayToIndex(weekday);
  const maxDay = daysInMonthZoned(year, month);

  if (ordinal > 0) {
    const firstWeekday = temporalDayToWeekdayIndex(Temporal.PlainDate.from({ year, month, day: 1 }).dayOfWeek);
    const firstMatchingDay = 1 + ((weekdayIndex - firstWeekday + 7) % 7);
    const dayOfMonth = firstMatchingDay + (ordinal - 1) * 7;
    return dayOfMonth <= maxDay ? Temporal.PlainDate.from({ year, month, day: dayOfMonth }) : null;
  }

  const lastWeekday = temporalDayToWeekdayIndex(Temporal.PlainDate.from({ year, month, day: maxDay }).dayOfWeek);
  const lastMatchingDay = maxDay - ((lastWeekday - weekdayIndex + 7) % 7);
  const dayOfMonth = lastMatchingDay + (ordinal + 1) * 7;
  return dayOfMonth >= 1 ? Temporal.PlainDate.from({ year, month, day: dayOfMonth }) : null;
}

function startOfWeek(date, weekStartDayIndex) {
  const midnight = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diff = (midnight.getUTCDay() - weekStartDayIndex + 7) % 7;
  return addDays(midnight, -diff);
}

function pickUtcTime(date) {
  return {
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
    seconds: date.getUTCSeconds(),
    milliseconds: date.getUTCMilliseconds(),
  };
}

function withUtcTime(date, time) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      time.hours,
      time.minutes,
      time.seconds,
      time.milliseconds
    )
  );
}

function isWithinRange(start, rangeStart, rangeEnd) {
  const startMs = Date.parse(start);
  return startMs >= Date.parse(rangeStart) && startMs < Date.parse(rangeEnd);
}
