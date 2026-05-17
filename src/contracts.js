// @ts-check

/**
 * @typedef {null | boolean | number | string | unknown[] | { [key: string]: unknown }} JsonValue
 */

/**
 * @typedef {object} ErrorEnvelope
 * @property {string} code
 * @property {string} message
 * @property {string | undefined} [requestId]
 * @property {JsonValue | undefined} [details]
 */

/**
 * @typedef {object} ApiErrorPayload
 * @property {ErrorEnvelope} error
 */

/**
 * @template T
 * @typedef {object} SuccessPayload
 * @property {T} data
 */

/**
 * @typedef {"DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"} RecurrenceFrequency
 */

/**
 * @typedef {"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"} Weekday
 */

/**
 * @typedef {object} RecurrencePayload
 * @property {RecurrenceFrequency} freq
 * @property {number | undefined} [interval]
 * @property {number | null | undefined} [count]
 * @property {string | null | undefined} [until]
 * @property {Weekday[] | string[] | undefined} [byDay]
 * @property {number[] | undefined} [byMonthDay]
 * @property {Weekday | null | undefined} [weekStart]
 * @property {string[] | undefined} [exDates]
 */

/**
 * @typedef {object} EventPayload
 * @property {string} id
 * @property {string | undefined} [calendarId]
 * @property {string} title
 * @property {string | undefined} [description]
 * @property {string} start
 * @property {string} end
 * @property {boolean | undefined} [allDay]
 * @property {string | undefined} [timezone]
 * @property {string | undefined} [location]
 * @property {boolean | undefined} [protected]
 * @property {RecurrencePayload | null | undefined} [recurrence]
 * @property {string | null | undefined} [seriesId]
 * @property {string | null | undefined} [occurrenceStart]
 * @property {boolean | undefined} [isRecurring]
 * @property {string | null | undefined} [createdAt]
 * @property {string | null | undefined} [updatedAt]
 * @property {string | null | undefined} [uid]
 * @property {number | undefined} [sequence]
 * @property {JsonValue[] | null | undefined} [notifications]
 */

/**
 * @typedef {object} EventListPayload
 * @property {EventPayload[]} events
 * @property {string | null} nextCursor
 */

/**
 * @typedef {object} RangePayload
 * @property {string} start
 * @property {string} end
 */

/**
 * @typedef {object} CliEventListPayload
 * @property {EventPayload[]} events
 * @property {number} count
 * @property {RangePayload} range
 * @property {string | null} calendarId
 */

/**
 * @typedef {object} EventCreatePayload
 * @property {string} title
 * @property {string} start
 * @property {string} end
 * @property {string} timezone
 * @property {string | undefined} [description]
 * @property {string | undefined} [location]
 * @property {boolean | undefined} [allDay]
 * @property {boolean | undefined} [protected]
 * @property {RecurrencePayload | undefined} [recurrence]
 * @property {string | undefined} [reminder]
 * @property {string | undefined} [reminders]
 * @property {JsonValue[] | null | undefined} [notifications]
 */

/**
 * @typedef {Partial<Omit<EventCreatePayload, "recurrence">> & { recurrence?: RecurrencePayload | null, notifications?: JsonValue[] | null }} EventPatchPayload
 */

/**
 * @typedef {object} ProtonCalendarResponse
 * @property {string | undefined} [ID]
 * @property {string | undefined} [Name]
 * @property {string | undefined} [Color]
 * @property {number | undefined} [Permissions]
 * @property {JsonValue | undefined} [Type]
 * @property {JsonValue | undefined} [CalendarType]
 * @property {JsonValue | undefined} [Flags]
 * @property {JsonValue | undefined} [CalendarFlags]
 * @property {boolean | number | undefined} [ReadOnly]
 * @property {boolean | number | undefined} [IsReadOnly]
 * @property {JsonValue | undefined} [SyncStatus]
 * @property {JsonValue | undefined} [SyncState]
 */

/**
 * @typedef {object} ProtonEventResponse
 * @property {string | undefined} [ID]
 * @property {string | undefined} [CalendarID]
 * @property {number | undefined} [StartTime]
 * @property {number | undefined} [EndTime]
 * @property {string | undefined} [StartTimezone]
 * @property {string | undefined} [RecurringID]
 * @property {number | undefined} [RecurrenceID]
 * @property {number | undefined} [CreateTime]
 * @property {number | undefined} [ModifyTime]
 * @property {string | undefined} [UID]
 * @property {number | undefined} [IsOrganizer]
 * @property {JsonValue[] | undefined} [SharedEvents]
 * @property {string | undefined} [SharedKeyPacket]
 * @property {JsonValue[] | null | undefined} [Notifications]
 */

export {};
