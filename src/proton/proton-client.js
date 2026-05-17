import { setTimeout as delay } from "node:timers/promises";
import * as openpgp from "openpgp";
import { buildRefreshCookieHeader, buildRefreshUrls, extractRefreshPayloadFromCookies } from "./internal/auth-refresh.js";
import { fromBase64, toBase64 } from "./internal/base64.js";
import { fetchRangeRawEvents, fetchRawEvent, syncCalendarEvents } from "./internal/calendar-api.js";
import { describeCookieChanges, flattenBundleCookies, getSetCookieHeaders } from "./internal/cookies.js";
import { decryptAddressPassphrase, decryptPersistedSessionKeyPassword, decryptSymmetricMessageUtf8 } from "./internal/crypto.js";
import { parseResponsePayload } from "./internal/http.js";
import { requestProtonJson } from "./internal/http-client.js";
import { buildSharedParts, hasDateValueProperty, parseIcsRecurrence, parseVcalUtc, parseVeventProperties, unescapeIcsText } from "./internal/ics.js";
import { assertSyncDeleteResponse, assertSyncEventResponse, buildCreateSyncRequestBody, buildUpdateSyncRequestBody, resolveUpdateRecurrence } from "./internal/sync-payloads.js";
import { parseCursor, readInteger, toUnix } from "./internal/time.js";
import { DEFAULT_PROTON_APP_VERSION } from "../constants.js";
import { ApiError } from "../errors.js";
import { ProtonAuthManager } from "./proton-auth-manager.js";

export { decryptPersistedSessionKeyPassword } from "./internal/crypto.js";
export { buildSharedParts, formatVcalWithTzid } from "./internal/ics.js";
export { buildCreateSyncRequestBody, buildUpdateSyncRequestBody, resolveUpdateRecurrence } from "./internal/sync-payloads.js";

const AUTH_REFRESH_PATHS = ["/api/auth/refresh", "/api/auth/v4/refresh"];
const EVENT_PAGE_LIMIT = 10;

export class ProtonCalendarClient {
  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.sessionStore = options.sessionStore;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.delay = options.delay || delay;
    this.retryAfterMaxMs = options.retryAfterMaxMs;
    this.appVersion = options.appVersion || DEFAULT_PROTON_APP_VERSION;
    this.locale = options.locale || "en-US";
    this.debugAuth = Boolean(options.debugAuth);
    this.authManager =
      options.authManager ||
      new ProtonAuthManager({
        sessionStore: this.sessionStore,
        enabled: options.autoRelogin,
        mode: options.reloginMode,
        timeoutMs: options.reloginTimeoutMs,
        pollSeconds: options.reloginPollSeconds,
        cooldownMs: options.reloginCooldownMs,
        recoveryLockPath: options.recoveryLockPath,
        chromePath: options.chromePath,
        profileDir: options.profileDir,
        loginUrl: options.loginUrl,
        bootstrapRunner: options.bootstrapRunner,
        debugAuth: options.debugAuth,
      });

    this.cachedUID = "";
    this.cachedUIDGeneration = null;
    this.cachedContext = null;
  }

  async authStatus() {
    const uid = await this.#getUID();
    const payload = await this.#requestJSON("GET", "/api/core/v4/users", { uid });
    return {
      uid,
      username: payload?.User?.Name || null,
      userId: payload?.User?.ID || null,
    };
  }

  async listCalendars() {
    const uid = await this.#getUID();
    const payload = await this.#requestJSON("GET", "/api/calendar/v1", { uid });
    const calendars = Array.isArray(payload?.Calendars) ? payload.Calendars : [];
    return calendars.map(normalizeCalendar).filter((calendar) => calendar.id);
  }

  async getUserCalendarSettings() {
    const uid = await this.#getUID();
    const payload = await this.#requestJSON("GET", "/api/settings/calendar", { uid });
    return normalizeUserCalendarSettings(payload);
  }

  async updateUserCalendarSettings(patch) {
    const uid = await this.#getUID();
    const current = await this.getUserCalendarSettings();
    const payload = await this.#requestJSON("PUT", "/api/settings/calendar", {
      uid,
      body: buildUserCalendarSettingsBody(patch, current.raw),
    });
    return normalizeUserCalendarSettings(payload);
  }

  async getCalendarSettings(calendarId) {
    const uid = await this.#getUID();
    const payload = await this.#requestJSON("GET", `/api/calendar/v1/${encodeURIComponent(calendarId)}/settings`, { uid });
    return normalizeCalendarSettings(calendarId, payload);
  }

  async updateCalendarSettings(calendarId, patch) {
    const uid = await this.#getUID();
    const current = await this.getCalendarSettings(calendarId);
    const payload = await this.#requestJSON("PUT", `/api/calendar/v1/${encodeURIComponent(calendarId)}/settings`, {
      uid,
      body: buildCalendarSettingsBody(patch, current.raw),
    });
    return normalizeCalendarSettings(calendarId, payload);
  }

  async updateCalendarMetadata(calendarId, patch) {
    const context = await this.#getContext(calendarId);
    const body = buildCalendarMetadataBody(patch, context.member);
    const payload = await this.#requestJSON(
      "PUT",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/members/${encodeURIComponent(context.memberId)}`,
      {
        uid: context.uid,
        body,
      }
    );
    const member = payload?.Member || payload?.Calendar || body;
    if (this.cachedContext?.calendarId === calendarId && this.cachedContext.memberId === context.memberId) {
      this.cachedContext = {
        ...this.cachedContext,
        member: cloneObject(member),
      };
    }
    return normalizeCalendarMetadata(calendarId, { Member: member });
  }

  async listEvents({ calendarId, start, end, limit, cursor }) {
    const uid = await this.#getUID();
    const startUnix = toUnix(start);
    const endUnix = toUnix(end);

    const rawEvents = await fetchRangeRawEvents({
      requestJSON: this.#requestJSON.bind(this),
      uid,
      calendarId,
      startUnix,
      endUnix,
      timezone: "UTC",
      pageSize: Math.min(100, Math.max(1, limit)),
      pageLimit: EVENT_PAGE_LIMIT,
    });

    const context = await this.#getContext(calendarId);
    const mapped = await Promise.all(rawEvents.map((event) => this.#toEventModel(context, event)));

    mapped.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

    const offset = parseCursor(cursor);
    const page = mapped.slice(offset, offset + limit);
    const nextCursor = offset + limit < mapped.length ? String(offset + limit) : null;

    return {
      events: page,
      nextCursor,
    };
  }

  async getEvent({ calendarId, eventId }) {
    const uid = await this.#getUID();
    const event = await fetchRawEvent({ requestJSON: this.#requestJSON.bind(this), uid, calendarId, eventId });

    const context = await this.#getContext(calendarId);
    return this.#toEventModel(context, event);
  }

  async createEvent({ calendarId, event, idempotencyKey }) {
    const context = await this.#getContext(calendarId);
    const uid = context.uid;

    const eventUid = `api-${Date.now()}-${Math.floor(Math.random() * 1e6)}@proton.me`;
    const startDate = new Date(event.start);
    const endDate = new Date(event.end);

    const sharedParts = buildSharedParts({
      uid: eventUid,
      sequence: 0,
      organizerEmail: context.addressEmail,
      startDate,
      endDate,
      allDay: Boolean(event.allDay),
      title: event.title,
      description: event.description || "",
      location: event.location || "",
      recurrence: event.recurrence || null,
      timezone: event.timezone || "UTC",
    });

    const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: context.calendarPublicKey });
    const sharedKeyPacket = await openpgp.encryptSessionKey({
      encryptionKeys: context.calendarPublicKey,
      data: sessionKey.data,
      algorithm: sessionKey.algorithm,
      format: "binary",
    });

    const sharedEventContent = await this.#encodeSharedEventContent(context, sharedParts, sessionKey);

    const body = buildCreateSyncRequestBody({
      memberId: context.memberId,
      sharedKeyPacket: toBase64(sharedKeyPacket),
      sharedEventContent,
      protected: event.protected,
      notifications: event.notifications,
    });

    const response = await syncCalendarEvents({
      requestJSON: this.#requestJSON.bind(this),
      uid,
      calendarId,
      body,
      idempotencyKey,
    });

    const created = assertSyncEventResponse(response);
    return this.#toEventModel(context, created);
  }

  async updateEvent({ calendarId, eventId, patch, idempotencyKey, scope = "series", occurrenceStart = null }) {
    const context = await this.#getContext(calendarId);
    const uid = context.uid;

    const existing = await fetchRawEvent({ requestJSON: this.#requestJSON.bind(this), uid, calendarId, eventId });

    const decoded = await this.#decodeSharedEvent(context, existing);

    const merged = {
      uid: existing.UID,
      sequence: (decoded.sequence || 0) + 1,
      startDate: patch.start ? new Date(patch.start) : new Date(existing.StartTime * 1000),
      endDate: patch.end ? new Date(patch.end) : new Date(existing.EndTime * 1000),
      allDay: typeof patch.allDay === "boolean" ? patch.allDay : Boolean(decoded.allDay),
      title: patch.title ?? decoded.title ?? "",
      description: patch.description ?? decoded.description ?? "",
      location: patch.location ?? decoded.location ?? "",
      recurrence: resolveUpdateRecurrence({
        scope,
        patchRecurrence: patch.recurrence,
        existingRecurrence: decoded.recurrence,
      }),
      organizerEmail: context.addressEmail,
      createdDate: decoded.createdDate,
      timezone: patch.timezone ?? String(existing.StartTimezone || "UTC"),
    };

    const sharedParts = buildSharedParts({
      uid: merged.uid,
      sequence: merged.sequence,
      organizerEmail: merged.organizerEmail,
      startDate: merged.startDate,
      endDate: merged.endDate,
      allDay: merged.allDay,
      title: merged.title,
      description: merged.description,
      location: merged.location,
      recurrence: merged.recurrence,
      createdDate: merged.createdDate,
      timezone: merged.timezone,
    });

    const sessionKey = await this.#decryptSharedSessionKey(context, existing.SharedKeyPacket);
    const sharedEventContent = await this.#encodeSharedEventContent(context, sharedParts, sessionKey);

    const effectiveProtected = typeof patch.protected === "boolean" ? patch.protected : (existing.IsOrganizer === 1);
    const body = buildUpdateSyncRequestBody({
      memberId: context.memberId,
      eventId,
      sharedEventContent,
      notifications: patch.notifications === undefined ? (existing.Notifications || null) : patch.notifications,
      color: existing.Color || null,
      scope,
      occurrenceStart,
      protected: effectiveProtected,
    });

    const response = await syncCalendarEvents({
      requestJSON: this.#requestJSON.bind(this),
      uid,
      calendarId,
      body,
      idempotencyKey,
    });

    const updated = assertSyncEventResponse(response);
    return this.#toEventModel(context, updated);
  }

  async deleteEvent({ calendarId, eventId, idempotencyKey, scope = "series", occurrenceStart = null }) {
    const context = await this.#getContext(calendarId);
    const uid = context.uid;
    const body = {
      MemberID: context.memberId,
      Events: [
        {
          ID: eventId,
          DeletionReason: scope === "single" ? 1 : scope === "following" ? 2 : 0,
          ...(occurrenceStart ? { RecurrenceID: toUnix(occurrenceStart) } : {}),
        },
      ],
    };

    const response = await syncCalendarEvents({
      requestJSON: this.#requestJSON.bind(this),
      uid,
      calendarId,
      body,
      idempotencyKey,
    });
    assertSyncDeleteResponse(response);
    return null;
  }

  async #toEventModel(context, rawEvent) {
    const decoded = await this.#decodeSharedEvent(context, rawEvent);

    return {
      id: String(rawEvent.ID || ""),
      calendarId: String(rawEvent.CalendarID || ""),
      title: decoded.title || "",
      description: decoded.description || "",
      start: new Date(Number(rawEvent.StartTime || 0) * 1000).toISOString(),
      end: new Date(Number(rawEvent.EndTime || 0) * 1000).toISOString(),
      allDay: Boolean(decoded.allDay),
      timezone: String(rawEvent.StartTimezone || "UTC"),
      location: decoded.location || "",
      recurrence: decoded.recurrence,
      seriesId: rawEvent.RecurringID || null,
      occurrenceStart: rawEvent.RecurrenceID
        ? new Date(Number(rawEvent.RecurrenceID) * 1000).toISOString()
        : null,
      createdAt: rawEvent.CreateTime ? new Date(rawEvent.CreateTime * 1000).toISOString() : null,
      updatedAt: rawEvent.ModifyTime ? new Date(rawEvent.ModifyTime * 1000).toISOString() : null,
      uid: rawEvent.UID || null,
      sequence: decoded.sequence || 0,
      protected: rawEvent.IsOrganizer === 1,
      notifications: normalizeEventNotifications(rawEvent.Notifications),
    };
  }

  async #decodeSharedEvent(context, rawEvent) {
    const sharedEvents = Array.isArray(rawEvent?.SharedEvents) ? rawEvent.SharedEvents : [];
    const signedCard = sharedEvents.find((item) => Number(item?.Type) === 2);
    const encryptedCard = sharedEvents.find((item) => Number(item?.Type) === 3);

    const signedProps = signedCard?.Data ? parseVeventProperties(signedCard.Data) : {};

    let encryptedProps = {};
    let encryptedText = "";
    if (encryptedCard?.Data && rawEvent?.SharedKeyPacket) {
      const sessionKey = await this.#decryptSharedSessionKey(context, rawEvent.SharedKeyPacket);
      encryptedText = await decryptSymmetricMessageUtf8(encryptedCard.Data, sessionKey);
      encryptedProps = parseVeventProperties(encryptedText);
    }

    return {
      allDay: hasDateValueProperty(signedCard?.Data || "", "DTSTART") || hasDateValueProperty(encryptedText, "DTSTART"),
      sequence: readInteger(signedProps.SEQUENCE, 0),
      createdDate: encryptedProps.CREATED ? parseVcalUtc(encryptedProps.CREATED) : null,
      title: unescapeIcsText(encryptedProps.SUMMARY || ""),
      description: unescapeIcsText(encryptedProps.DESCRIPTION || ""),
      location: unescapeIcsText(encryptedProps.LOCATION || ""),
      recurrence: parseIcsRecurrence(encryptedProps),
    };
  }

  async #encodeSharedEventContent(context, sharedParts, sessionKey) {
    const signedSignature = await openpgp.sign({
      message: await openpgp.createMessage({ text: sharedParts.signedPart }),
      signingKeys: context.addressPrivateKey,
      detached: true,
      format: "armored",
    });

    const encryptedSignature = await openpgp.sign({
      message: await openpgp.createMessage({ text: sharedParts.encryptedPart }),
      signingKeys: context.addressPrivateKey,
      detached: true,
      format: "armored",
    });

    const encryptedBinary = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: sharedParts.encryptedPart }),
      sessionKey,
      format: "binary",
    });

    return [
      {
        Type: 2,
        Data: sharedParts.signedPart,
        Signature: signedSignature,
      },
      {
        Type: 3,
        Data: toBase64(encryptedBinary),
        Signature: encryptedSignature,
      },
    ];
  }

  async #decryptSharedSessionKey(context, sharedKeyPacketBase64) {
    return this.#decryptSessionKeyPacket({
      privateKey: context.calendarPrivateKey,
      packetBase64: sharedKeyPacketBase64,
      errorMessage: "Unable to decrypt event shared session key",
    });
  }

  async #decryptSessionKeyPacket({ privateKey, packetBase64, errorMessage }) {
    const message = await openpgp.readMessage({ binaryMessage: fromBase64(packetBase64) });
    const keys = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: privateKey,
    });

    if (!Array.isArray(keys) || keys.length === 0) {
      throw new ApiError(502, "UPSTREAM_INVALID_EVENT", errorMessage);
    }

    return keys[0];
  }

  async #getUID() {
    const sessionGeneration = await this.#getSessionGeneration();
    if (this.cachedUID && this.cachedUIDGeneration === sessionGeneration) {
      return this.cachedUID;
    }
    if (this.cachedUID) {
      this.#resetAuthCaches();
    }

    const candidates = await this.sessionStore.getUIDCandidates();
    if (candidates.length === 0) {
      throw new ApiError(401, "UID_MISSING", "Cookie bundle does not include uidCandidates");
    }

    for (const candidate of candidates) {
      try {
        await this.#requestJSON("GET", "/api/core/v4/users", { uid: candidate, allowAuthFailure: false });
        this.cachedUID = candidate;
        this.cachedUIDGeneration = sessionGeneration;
        return candidate;
      } catch {
        continue;
      }
    }

    throw new ApiError(401, "AUTH_EXPIRED", "Unable to authenticate with any UID candidate");
  }

  async #getContext(calendarId) {
    const sessionGeneration = await this.#getSessionGeneration();
    if (
      this.cachedContext?.calendarId === calendarId &&
      (sessionGeneration === null || this.cachedContext.sessionGeneration === sessionGeneration)
    ) {
      return this.cachedContext;
    }

    const { uid, keyPassword } = await this.#getContextAuth();

    const [userPayload, addressesPayload, bootstrapPayload] = await Promise.all([
      this.#requestJSON("GET", "/api/core/v4/users", { uid }),
      this.#requestJSON("GET", "/api/core/v4/addresses", { uid }),
      this.#requestJSON("GET", `/api/calendar/v2/${encodeURIComponent(calendarId)}/bootstrap`, { uid }),
    ]);

    const user = userPayload?.User;
    const addresses = Array.isArray(addressesPayload?.Addresses) ? addressesPayload.Addresses : [];
    const members = Array.isArray(bootstrapPayload?.Members) ? bootstrapPayload.Members : [];
    const calendarKeys = Array.isArray(bootstrapPayload?.Keys) ? bootstrapPayload.Keys : [];
    const memberPassphrases = Array.isArray(bootstrapPayload?.Passphrase?.MemberPassphrases)
      ? bootstrapPayload.Passphrase.MemberPassphrases
      : [];

    if (!user?.Keys?.[0]?.PrivateKey) {
      throw new ApiError(502, "UPSTREAM_INVALID_KEYS", "User private key is missing");
    }
    if (calendarKeys.length === 0 || !calendarKeys[0]?.PrivateKey) {
      throw new ApiError(502, "UPSTREAM_INVALID_KEYS", "Calendar private key is missing");
    }
    if (members.length === 0) {
      throw new ApiError(502, "UPSTREAM_INVALID_KEYS", "Calendar member data is missing");
    }

    const member = members[0];
    const address =
      addresses.find((item) => item?.ID === member?.AddressID) ||
      addresses.find((item) => item?.Email === member?.Email) ||
      addresses[0];
    if (!address?.Keys?.length) {
      throw new ApiError(502, "UPSTREAM_INVALID_KEYS", "Address key data is missing");
    }

    const primaryAddressKey = address.Keys.find((item) => Number(item?.Primary) === 1) || address.Keys[0];

    let userPrivateKey = await openpgp.readPrivateKey({ armoredKey: user.Keys[0].PrivateKey });
    userPrivateKey = await openpgp.decryptKey({ privateKey: userPrivateKey, passphrase: keyPassword });
    const userPublicKey = userPrivateKey.toPublic();

    const addressPassphrase = await decryptAddressPassphrase({
      token: primaryAddressKey.Token,
      signature: primaryAddressKey.Signature,
      userPrivateKey,
      userPublicKey,
      fallbackPassphrase: keyPassword,
    });

    let addressPrivateKey = await openpgp.readPrivateKey({ armoredKey: primaryAddressKey.PrivateKey });
    addressPrivateKey = await openpgp.decryptKey({ privateKey: addressPrivateKey, passphrase: addressPassphrase });

    const memberPassphraseEntry =
      memberPassphrases.find((item) => item?.MemberID === member.ID) || memberPassphrases[0];
    if (!memberPassphraseEntry?.Passphrase) {
      throw new ApiError(502, "UPSTREAM_INVALID_KEYS", "Calendar member passphrase is missing");
    }

    const calendarPassphrase = String(
      (
        await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: memberPassphraseEntry.Passphrase }),
          decryptionKeys: addressPrivateKey,
          format: "utf8",
        })
      ).data
    );

    let calendarPrivateKey = await openpgp.readPrivateKey({ armoredKey: calendarKeys[0].PrivateKey });
    calendarPrivateKey = await openpgp.decryptKey({
      privateKey: calendarPrivateKey,
      passphrase: calendarPassphrase,
    });
    const calendarPublicKey = calendarPrivateKey.toPublic();

    this.cachedContext = {
      uid,
      calendarId,
      sessionGeneration,
      memberId: member.ID,
      member: cloneObject(member),
      addressEmail: address.Email,
      addressPrivateKey,
      calendarPrivateKey,
      calendarPublicKey,
    };

    return this.cachedContext;
  }

  async #getContextAuth() {
    const uid = await this.#getUID();
    const persistedSessions = await this.sessionStore.getPersistedSessions();
    const candidates = await this.sessionStore.getUIDCandidates();
    const candidatesWithSessions = candidates.filter((candidate) => findPersistedSession(persistedSessions, candidate, { exact: true })?.blob);
    const keyCandidates = [...new Set([uid, ...candidatesWithSessions])];
    let lastError = null;

    for (const candidate of keyCandidates) {
      const persistedSession = findPersistedSession(persistedSessions, candidate, { exact: true });
      if (!persistedSession?.blob) {
        continue;
      }
      try {
        const localKeyPayload = await this.#requestJSON("GET", "/api/auth/v4/sessions/local/key", { uid: candidate, allowAuthFailure: false });
        const keyPassword = await decryptPersistedSessionKeyPassword({
          clientKeyBase64: localKeyPayload?.ClientKey,
          persistedBlobBase64: persistedSession.blob,
        });
        return { uid, keyPassword };
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new ApiError(
      401,
      "SESSION_BLOB_MISSING",
      "Persisted Proton session blob is missing; rerun cookie bootstrap"
    );
  }

  async #attemptAuthRefresh(uid) {
    const refreshPayload = await this.#extractRefreshPayload(uid);
    if (!refreshPayload) {
      this.#authLog("No refresh payload available in cookie bundle", { uid });
      return false;
    }

    const refreshUrls = buildRefreshUrls(this.baseUrl, AUTH_REFRESH_PATHS);
    for (const refreshUrl of refreshUrls) {
      const success = await this.#refreshViaUrl(uid, refreshUrl, refreshPayload);
      if (!success) {
        continue;
      }

      try {
        await this.#requestJSON("GET", "/api/core/v4/users", {
          uid,
          allowAuthRefresh: false,
          allowRelogin: false,
        });
        this.#resetAuthCaches();
        this.#authLog("Auth refresh validated", { uid, refreshUrl });
        return true;
      } catch {
        this.#authLog("Auth refresh path did not validate", { uid, refreshUrl });
      }
    }

    return false;
  }

  async #refreshViaUrl(uid, refreshUrl, refreshPayload) {
    const url = new URL(refreshUrl);
    const cookieHeader = await this.#buildRefreshCookieHeader(url, uid);
    if (!cookieHeader) {
      this.#authLog("Skipping refresh path because cookie header is empty", { refreshUrl });
      return false;
    }

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.protonmail.v1+json",
          Cookie: cookieHeader,
          "Content-Type": "application/json",
          "x-pm-appversion": this.appVersion,
          "x-pm-locale": this.locale,
          "x-pm-uid": uid,
        },
        body: JSON.stringify(refreshPayload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const changes = await this.#persistResponseCookies(url, response, `refresh:${refreshUrl}`);
      const payload = await parseResponsePayload(response);

      if (!response.ok) {
        this.#authLog("Refresh request failed", {
          refreshUrl,
          status: response.status,
          code: payload?.Code,
        });
        return false;
      }

      if (payload && typeof payload === "object" && typeof payload.Code === "number") {
        if (![1000, 1001].includes(payload.Code)) {
          this.#authLog("Refresh response code not successful", {
            refreshUrl,
            code: payload.Code,
          });
          return false;
        }
      }

      if (changes.length > 0) {
        this.#authLog("Refresh updated cookie bundle", {
          refreshUrl,
          changes: describeCookieChanges(changes),
        });
      } else {
        this.#authLog("Refresh succeeded without cookie deltas", { refreshUrl });
      }

      return true;
    } catch (error) {
      this.#authLog("Refresh request crashed", {
        refreshUrl,
        message: error?.message,
      });
      return false;
    }
  }

  async #buildRefreshCookieHeader(url, uid) {
    const scopedHeader = await this.sessionStore.getCookieHeader(url.toString());
    return buildRefreshCookieHeader({
      scopedHeader,
      cookies: await this.#getBundleCookies(),
      uid,
    });
  }

  async #getBundleCookies() {
    if (typeof this.sessionStore.getBundle !== "function") {
      return [];
    }

    try {
      const bundle = await this.sessionStore.getBundle();
      return flattenBundleCookies(bundle);
    } catch {
      return [];
    }
  }

  async #extractRefreshPayload(uid) {
    return extractRefreshPayloadFromCookies(await this.#getBundleCookies(), uid);
  }

  async #persistResponseCookies(url, response, reason) {
    if (typeof this.sessionStore.applySetCookieHeaders !== "function") {
      return [];
    }

    const setCookies = getSetCookieHeaders(response.headers);
    if (setCookies.length === 0) {
      return [];
    }

    const changes = await this.sessionStore.applySetCookieHeaders(url.toString(), setCookies);
    if (changes.length > 0) {
      this.#authLog("Captured Set-Cookie headers", {
        reason,
        changes: describeCookieChanges(changes),
      });
    }

    return changes;
  }

  #authLog(message, details = undefined) {
    if (!this.debugAuth) {
      return;
    }

    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    console.log(`[proton-auth] ${message}${suffix}`);
  }

  async #requestJSON(method, pathname, options = {}) {
    return await requestProtonJson({
      method,
      pathname,
      options,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      sessionStore: this.sessionStore,
      appVersion: this.appVersion,
      locale: this.locale,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      retryAfterMaxMs: this.retryAfterMaxMs,
      delay: this.delay,
      getUID: this.#getUID.bind(this),
      attemptAuthRefresh: this.#attemptAuthRefresh.bind(this),
      attemptRelogin: this.#attemptRelogin.bind(this),
      persistResponseCookies: this.#persistResponseCookies.bind(this),
    });
  }

  async #attemptRelogin(uid, reason) {
    if (!this.authManager || typeof this.authManager.recover !== "function") {
      return false;
    }

    const recovered = await this.authManager.recover({ uid, reason });
    if (!recovered) {
      return false;
    }

    if (typeof this.sessionStore.invalidate === "function") {
      await this.sessionStore.invalidate();
    }

    this.#resetAuthCaches();
    this.#authLog("Relogin recovered session", { uid, reason });
    return true;
  }

  #resetAuthCaches() {
    this.cachedUID = "";
    this.cachedUIDGeneration = null;
    this.cachedContext = null;
  }

  async #getSessionGeneration() {
    if (typeof this.sessionStore.getGeneration !== "function") {
      return null;
    }
    return await this.sessionStore.getGeneration();
  }
}

function normalizeCalendar(calendar) {
  const id = String(calendar?.ID || calendar?.CalendarID || "").trim();
  const name = String(calendar?.Name || calendar?.DisplayName || calendar?.Title || id).trim();
  const normalized = {
    id,
    name: name || id,
    color: calendar?.Color || null,
    permissions: calendar?.Permissions ?? null,
  };
  if (calendar?.Description !== undefined) {
    normalized.description = calendar.Description ? String(calendar.Description) : "";
  }
  if (calendar?.Display !== undefined) {
    normalized.display = calendar.Display;
  }
  copyFirstCalendarField(normalized, calendar, ["Type", "CalendarType", "type", "calendarType"], "type");
  copyFirstCalendarField(normalized, calendar, ["Flags", "CalendarFlags", "flags", "calendarFlags"], "flags");
  copyFirstCalendarField(normalized, calendar, ["SyncStatus", "SyncState", "syncStatus", "syncState"], "syncStatus");
  copyFirstCalendarBoolean(normalized, calendar, ["ReadOnly", "IsReadOnly", "readOnly", "isReadOnly"], "readOnly");
  return normalized;
}

function copyFirstCalendarField(target, source, sourceKeys, targetKey) {
  for (const sourceKey of sourceKeys) {
    if (source?.[sourceKey] !== undefined) {
      target[targetKey] = cloneCalendarMetadataValue(source[sourceKey]);
      return;
    }
  }
}

function cloneCalendarMetadataValue(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneCalendarMetadataValue);
  }
  return JSON.parse(JSON.stringify(value));
}

function copyFirstCalendarBoolean(target, source, sourceKeys, targetKey) {
  for (const sourceKey of sourceKeys) {
    const value = source?.[sourceKey];
    if (value === undefined) {
      continue;
    }
    target[targetKey] = value === true || value === 1;
    return;
  }
}

function normalizeUserCalendarSettings(payload) {
  const settings = payload?.CalendarSettings || payload?.Settings || payload || {};
  return {
    defaultCalendarId: settings.DefaultCalendarID || settings.DefaultCalendarId || settings.DefaultCalendar || null,
    defaultDuration: normalizeDuration(settings.DefaultEventDuration ?? settings.DefaultDuration ?? settings.Duration),
    notifications: normalizeProtonNotifications(settings.Notifications),
    raw: cloneObject(settings),
  };
}

function normalizeCalendarSettings(calendarId, payload) {
  const settings = payload?.CalendarSettings || payload?.Settings || payload || {};
  return {
    calendarId,
    defaultDuration: normalizeDuration(settings.DefaultEventDuration ?? settings.DefaultDuration ?? settings.Duration),
    notifications: normalizeProtonNotifications(settings.Notifications),
    raw: cloneObject(settings),
  };
}

function normalizeCalendarMetadata(calendarId, payload) {
  const calendar = payload?.Calendar || payload?.Member || payload || {};
  return {
    calendarId: String(calendar.CalendarID || calendar.ID || calendarId),
    name: calendar.Name || calendar.DisplayName || calendar.Title || null,
    description: calendar.Description || "",
    color: calendar.Color || null,
    display: calendar.Display ?? null,
    raw: cloneObject(calendar),
  };
}

function buildUserCalendarSettingsBody(patch, current = {}) {
  const body = cloneObject(current);
  if (patch.defaultCalendarId !== undefined) {
    body.DefaultCalendarID = patch.defaultCalendarId;
  }
  addSharedSettingsBodyFields(body, patch);
  return body;
}

function buildCalendarSettingsBody(patch, current = {}) {
  const body = cloneObject(current);
  addSharedSettingsBodyFields(body, patch, { preferDefaultDuration: Object.hasOwn(body, "DefaultDuration") && !Object.hasOwn(body, "DefaultEventDuration") });
  return body;
}

function addSharedSettingsBodyFields(body, patch, options = {}) {
  if (patch.defaultDuration !== undefined) {
    if (options.preferDefaultDuration) {
      body.DefaultDuration = patch.defaultDuration;
    } else {
      body.DefaultEventDuration = patch.defaultDuration;
    }
  }
  if (patch.notifications !== undefined) {
    body.Notifications = patch.notifications === null ? [] : patch.notifications.map(toProtonNotification);
  }
}

function buildCalendarMetadataBody(patch, current = {}) {
  const body = cloneObject(current);
  if (patch.name !== undefined) {
    body.Name = patch.name;
  }
  if (patch.description !== undefined) {
    body.Description = patch.description;
  }
  if (patch.color !== undefined) {
    body.Color = patch.color;
  }
  if (patch.display !== undefined) {
    body.Display = patch.display;
  }
  return body;
}

function toProtonNotification(notification) {
  return {
    Type: notification.type ?? notification.Type,
    Trigger: notification.trigger ?? notification.Trigger,
  };
}

function normalizeDuration(value) {
  const duration = Number(value);
  return Number.isInteger(duration) ? duration : null;
}

function cloneObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function findPersistedSession(persistedSessions, uid, options = {}) {
  const entries = Object.entries(persistedSessions || {});
  if (entries.length === 0) {
    return null;
  }

  for (const [, value] of entries) {
    if (value && typeof value === "object" && value.UID === uid && value.blob) {
      return value;
    }
  }

  if (options.exact) {
    return null;
  }

  for (const [, value] of entries) {
    if (value && typeof value === "object" && value.blob) {
      return value;
    }
  }

  return null;
}

function normalizeProtonNotifications(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return Array.isArray(value)
    ? value.map((item) => ({
        type: item?.type ?? item?.Type,
        trigger: item?.trigger ?? item?.Trigger,
      }))
    : null;
}

function normalizeEventNotifications(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : null;
}
