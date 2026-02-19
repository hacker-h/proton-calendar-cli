import { ApiError } from "../errors.js";

const ALLOWED_FIELDS = new Set(["title", "description", "start", "end", "timezone", "location"]);

export class CalendarService {
  constructor(options) {
    this.targetCalendarId = options.targetCalendarId;
    this.protonClient = options.protonClient;
    this.sessionStore = options.sessionStore;
  }

  async authStatus() {
    const session = await this.sessionStore.getSummary();
    try {
      const upstream = await this.protonClient.authStatus();
      return {
        authenticated: true,
        targetCalendarId: this.targetCalendarId,
        session,
        upstream,
      };
    } catch (error) {
      if (error.code === "AUTH_EXPIRED") {
        return {
          authenticated: false,
          targetCalendarId: this.targetCalendarId,
          session,
        };
      }
      throw error;
    }
  }

  async listEvents(input) {
    const range = validateRange(input.start, input.end);
    const limit = readLimit(input.limit);
    const cursor = readCursor(input.cursor);

    const result = await this.protonClient.listEvents({
      calendarId: this.targetCalendarId,
      start: range.start,
      end: range.end,
      limit,
      cursor,
    });

    const events = Array.isArray(result?.events) ? result.events.map(normalizeEvent) : [];
    const filtered = events.filter((event) => event.calendarId === this.targetCalendarId);

    return {
      events: filtered,
      nextCursor: result?.nextCursor || null,
    };
  }

  async getEvent(eventId) {
    ensureId(eventId);
    const event = normalizeEvent(
      await this.protonClient.getEvent({ calendarId: this.targetCalendarId, eventId })
    );
    this.#assertTargetCalendar(event);
    return event;
  }

  async createEvent(payload, idempotencyKey) {
    assertSingleCalendarPayload(payload, this.targetCalendarId);
    const eventInput = validateCreatePayload(payload);

    const created = normalizeEvent(
      await this.protonClient.createEvent({
        calendarId: this.targetCalendarId,
        event: eventInput,
        idempotencyKey,
      })
    );

    this.#assertTargetCalendar(created);
    return created;
  }

  async updateEvent(eventId, payload, idempotencyKey) {
    ensureId(eventId);
    assertSingleCalendarPayload(payload, this.targetCalendarId);
    const patch = validatePatchPayload(payload);

    const updated = normalizeEvent(
      await this.protonClient.updateEvent({
        calendarId: this.targetCalendarId,
        eventId,
        patch,
        idempotencyKey,
      })
    );

    this.#assertTargetCalendar(updated);
    return updated;
  }

  async deleteEvent(eventId, idempotencyKey) {
    ensureId(eventId);
    await this.protonClient.deleteEvent({
      calendarId: this.targetCalendarId,
      eventId,
      idempotencyKey,
    });
    return { deleted: true, eventId };
  }

  #assertTargetCalendar(event) {
    if (event.calendarId !== this.targetCalendarId) {
      throw new ApiError(502, "CALENDAR_SCOPE_VIOLATION", "Upstream returned data outside target calendar", {
        expected: this.targetCalendarId,
        received: event.calendarId,
      });
    }
  }
}

function assertSingleCalendarPayload(payload, targetCalendarId) {
  if (payload && payload.calendarId !== undefined && typeof payload.calendarId !== "string") {
    throw new ApiError(400, "INVALID_PAYLOAD", "calendarId must be a string when provided");
  }
  if (payload?.calendarId && payload.calendarId !== targetCalendarId) {
    throw new ApiError(400, "CALENDAR_SCOPE_VIOLATION", "calendarId cannot be overridden");
  }
  if (payload?.recurrence !== undefined || payload?.rrule !== undefined) {
    throw new ApiError(400, "SINGLE_INSTANCE_ONLY", "Recurring events are not supported");
  }
}

function validateCreatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }

  const title = requireString(payload.title, "title", 1, 200);
  const timezone = requireString(payload.timezone, "timezone", 1, 100);
  const start = requireDate(payload.start, "start");
  const end = requireDate(payload.end, "end");

  if (Date.parse(end) <= Date.parse(start)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "end must be after start");
  }

  return {
    title,
    description: optionalString(payload.description, "description", 0, 4000),
    start,
    end,
    timezone,
    location: optionalString(payload.location, "location", 0, 400),
  };
}

function validatePatchPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object");
  }

  const patch = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ALLOWED_FIELDS.has(key) && key !== "calendarId") {
      throw new ApiError(400, "INVALID_FIELD", `Unsupported field: ${key}`);
    }
    if (key === "calendarId") {
      continue;
    }

    if (key === "start" || key === "end") {
      patch[key] = requireDate(value, key);
      continue;
    }
    if (key === "title") {
      patch[key] = requireString(value, key, 1, 200);
      continue;
    }
    if (key === "timezone") {
      patch[key] = requireString(value, key, 1, 100);
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
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "EMPTY_PATCH", "At least one mutable field is required");
  }

  if (patch.start && patch.end && Date.parse(patch.end) <= Date.parse(patch.start)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "end must be after start");
  }

  return patch;
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream event payload is invalid");
  }

  const normalized = {
    id: String(event.id || event.eventId || event.uid || ""),
    calendarId: String(event.calendarId || event.calendarID || event.calendar_id || ""),
    title: String(event.title || ""),
    description: event.description ? String(event.description) : "",
    start: String(event.start || event.startAt || event.start_time || ""),
    end: String(event.end || event.endAt || event.end_time || ""),
    timezone: String(event.timezone || event.tz || "UTC"),
    location: event.location ? String(event.location) : "",
    createdAt: event.createdAt || event.created_at || null,
    updatedAt: event.updatedAt || event.updated_at || null,
  };

  if (!normalized.id || !normalized.calendarId || !normalized.title || !normalized.start || !normalized.end) {
    throw new ApiError(502, "UPSTREAM_INVALID_EVENT", "Upstream event payload missing required fields");
  }

  return normalized;
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

function readCursor(rawCursor) {
  if (rawCursor === undefined || rawCursor === null || rawCursor === "") {
    return null;
  }
  return String(rawCursor);
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

function requireDate(value, field) {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} must be an ISO date-time string`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ApiError(400, "INVALID_PAYLOAD", `${field} must be an ISO date-time string`);
  }
  return new Date(parsed).toISOString();
}
