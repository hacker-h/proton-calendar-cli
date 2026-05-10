// @ts-check

/** @typedef {import("./contracts.js").ApiErrorPayload} ApiErrorPayload */
/** @typedef {import("./contracts.js").CliEventListPayload} CliEventListPayload */
/** @typedef {import("./contracts.js").EventCreatePayload} EventCreatePayload */
/** @typedef {import("./contracts.js").EventListPayload} EventListPayload */
/** @typedef {import("./contracts.js").EventPatchPayload} EventPatchPayload */
/** @typedef {import("./contracts.js").ProtonEventResponse} ProtonEventResponse */
/** @typedef {import("./contracts.js").RecurrencePayload} RecurrencePayload */
/** @typedef {import("./contracts.js").SuccessPayload<EventListPayload>} EventListSuccessPayload */
/** @typedef {import("./contracts.js").SuccessPayload<CliEventListPayload>} CliEventListSuccessPayload */

/** @satisfies {RecurrencePayload} */
const _normalizedRecurrencePayload = {
  freq: "DAILY",
  count: null,
  until: null,
  weekStart: null,
  byDay: ["MO"],
  byMonthDay: [1],
  exDates: ["2026-03-11T10:00:00.000Z"],
};

/** @satisfies {EventListSuccessPayload} */
const _apiListSuccessPayload = {
  data: {
    events: [
      {
        id: "evt-1",
        calendarId: "assistant-calendar",
        title: "Design review",
        description: "",
        start: "2026-03-10T10:00:00.000Z",
        end: "2026-03-10T10:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        location: "Room A",
        protected: false,
        recurrence: _normalizedRecurrencePayload,
        seriesId: null,
        occurrenceStart: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    nextCursor: null,
  },
};

/** @satisfies {CliEventListSuccessPayload} */
const _cliListSuccessPayload = {
  data: {
    events: [
      {
        id: "evt-1",
        title: "Design review",
        start: "2026-03-10T10:00:00.000Z",
        end: "2026-03-10T10:30:00.000Z",
        location: "Room A",
        protected: true,
      },
    ],
    count: 1,
    range: {
      start: "2026-03-10T00:00:00.000Z",
      end: "2026-03-11T00:00:00.000Z",
    },
    calendarId: null,
  },
};

/** @satisfies {EventCreatePayload} */
const _eventCreatePayload = {
  title: "Design review",
  start: "2026-03-10T10:00:00.000Z",
  end: "2026-03-10T10:30:00.000Z",
  timezone: "UTC",
  protected: false,
};

/** @satisfies {EventPatchPayload} */
const _eventPatchPayload = {
  title: "Updated design review",
  recurrence: null,
};

/** @satisfies {ProtonEventResponse} */
const _protonEventResponse = {
  ID: "evt-1",
  CalendarID: "assistant-calendar",
  StartTime: 1773136800,
  EndTime: 1773138600,
  StartTimezone: "UTC",
  SharedEvents: [],
  SharedKeyPacket: "packet",
};

/** @satisfies {ApiErrorPayload} */
const _apiErrorPayload = {
  error: {
    code: "UPSTREAM_ERROR",
    message: "Proton upstream request failed",
    requestId: "request-id",
    details: {
      code: 1000,
    },
  },
};

export {};
