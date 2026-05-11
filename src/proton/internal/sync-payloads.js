import { ApiError } from "../../errors.js";
import { sanitizeUpstreamPayload } from "./http.js";
import { toUnix } from "./time.js";

const PROTON_ATTENDEE_PERMISSIONS = Object.freeze({
  SEE: 1,
  INVITE: 2,
  SEE_AND_INVITE: 3,
  EDIT: 4,
  DELETE: 8,
});
const PROTON_IS_ORGANIZER = 1;

export function buildCreateSyncRequestBody({ memberId, sharedKeyPacket, sharedEventContent, protected: isProtected = true }) {
  const permissions = isProtected ? PROTON_ATTENDEE_PERMISSIONS.SEE_AND_INVITE : PROTON_ATTENDEE_PERMISSIONS.SEE;
  const isOrganizer = isProtected ? PROTON_IS_ORGANIZER : 0;
  return {
    MemberID: memberId,
    Events: [
      {
        Overwrite: 0,
        Event: {
          Permissions: permissions,
          IsOrganizer: isOrganizer,
          SharedKeyPacket: sharedKeyPacket,
          SharedEventContent: sharedEventContent,
          Notifications: null,
          Color: null,
        },
      },
    ],
  };
}

export function buildUpdateSyncRequestBody({
  memberId,
  eventId,
  sharedEventContent,
  notifications,
  color,
  scope = "series",
  occurrenceStart = null,
  protected: isProtected = true,
}) {
  const permissions = isProtected ? PROTON_ATTENDEE_PERMISSIONS.SEE_AND_INVITE : PROTON_ATTENDEE_PERMISSIONS.SEE;
  const isOrganizer = isProtected ? PROTON_IS_ORGANIZER : 0;
  return {
    MemberID: memberId,
    Events: [
      {
        ID: eventId,
        Event: {
          Permissions: permissions,
          IsOrganizer: isOrganizer,
          IsBreakingChange: scope === "following" ? 1 : 0,
          IsPersonalSingleEdit: scope === "single",
          SharedEventContent: sharedEventContent,
          Notifications: notifications,
          Color: color,
          ...(occurrenceStart ? { RecurrenceID: toUnix(occurrenceStart) } : {}),
        },
      },
    ],
  };
}

export function resolveUpdateRecurrence({ scope = "series", patchRecurrence, existingRecurrence }) {
  if (scope === "single") {
    return null;
  }

  if (patchRecurrence === undefined) {
    return existingRecurrence;
  }

  return patchRecurrence;
}

export function assertSyncEventResponse(payload) {
  if (payload?.Code !== 1001 || !Array.isArray(payload?.Responses) || payload.Responses.length === 0) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Unexpected sync response payload", sanitizeUpstreamPayload(payload));
  }

  const op = payload.Responses[0]?.Response;
  if (!op) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Missing sync operation response", sanitizeUpstreamPayload(payload));
  }

  if (op.Code !== 1000) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Sync operation failed", {
      code: op.Code,
    });
  }

  if (!op.Event) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Missing event in sync response", sanitizeUpstreamPayload(payload));
  }

  return op.Event;
}

export function assertSyncDeleteResponse(payload) {
  if (![1000, 1001].includes(payload?.Code)) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Delete operation failed", sanitizeUpstreamPayload(payload));
  }

  if (!Array.isArray(payload?.Responses)) {
    return;
  }

  for (const item of payload.Responses) {
    const op = item?.Response;
    if (op && op.Code !== 1000) {
      throw new ApiError(502, "UPSTREAM_ERROR", "Delete operation failed", {
        code: op.Code,
      });
    }
  }
}
