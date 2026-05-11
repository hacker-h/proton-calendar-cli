import { ApiError } from "../../errors.js";

export async function fetchRangeRawEvents({ requestJSON, uid, calendarId, startUnix, endUnix, timezone, pageSize, pageLimit }) {
  const dedupe = new Map();
  const queryTypes = [0, 1, 2, 3];

  for (const type of queryTypes) {
    let page = 0;
    let more = true;
    while (more && page < pageLimit) {
      const payload = await requestJSON(
        "GET",
        `/api/calendar/v1/${encodeURIComponent(calendarId)}/events`,
        {
          uid,
          query: {
            Start: String(startUnix),
            End: String(endUnix),
            Timezone: timezone,
            Type: String(type),
            PageSize: String(pageSize),
            Page: String(page),
            MetaDataOnly: "0",
          },
        }
      );

      const events = Array.isArray(payload?.Events) ? payload.Events : [];
      for (const event of events) {
        if (event?.ID) {
          dedupe.set(event.ID, event);
        }
      }

      more = Boolean(payload?.More);
      page += 1;
    }

    if (more) {
      throw new ApiError(502, "UPSTREAM_EVENT_PAGE_LIMIT", "Proton event listing exceeded the page limit", {
        calendarId,
        startUnix,
        endUnix,
        type,
        pageLimit,
        pageSize,
      });
    }
  }

  return [...dedupe.values()];
}

export async function fetchRawEvent({ requestJSON, uid, calendarId, eventId }) {
  const payload = await requestJSON(
    "GET",
    `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { uid }
  );

  if (!payload?.Event) {
    throw new ApiError(404, "NOT_FOUND", "Event not found");
  }

  return payload.Event;
}

export function syncEventPath(calendarId) {
  return `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/sync`;
}

export async function syncCalendarEvents({ requestJSON, uid, calendarId, body, idempotencyKey }) {
  return await requestJSON("PUT", syncEventPath(calendarId), { uid, body, idempotencyKey });
}
