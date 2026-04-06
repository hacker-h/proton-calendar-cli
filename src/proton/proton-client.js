import { setTimeout as delay } from "node:timers/promises";
import * as openpgp from "openpgp";
import { ApiError } from "../errors.js";
import { ProtonAuthManager } from "./proton-auth-manager.js";

const DEFAULT_APP_VERSION = "web-calendar@5.0.101.3";
const AUTH_REFRESH_PATHS = ["/api/auth/refresh", "/api/auth/v4/refresh"];
const PROTON_ATTENDEE_PERMISSIONS = Object.freeze({
  SEE: 1,
  INVITE: 2,
  SEE_AND_INVITE: 3,
  EDIT: 4,
  DELETE: 8,
});
const PROTON_IS_ORGANIZER = 1;

export class ProtonCalendarClient {
  constructor(options) {
    this.baseUrl = new URL(options.baseUrl);
    this.sessionStore = options.sessionStore;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.appVersion = options.appVersion || DEFAULT_APP_VERSION;
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

  async listEvents({ calendarId, start, end, limit, cursor }) {
    const uid = await this.#getUID();
    const startUnix = toUnix(start);
    const endUnix = toUnix(end);

    const rawEvents = await this.#fetchRangeRawEvents({
      uid,
      calendarId,
      startUnix,
      endUnix,
      timezone: "UTC",
      pageSize: Math.min(100, Math.max(1, limit)),
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
    const payload = await this.#requestJSON(
      "GET",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { uid }
    );

    if (!payload?.Event) {
      throw new ApiError(404, "NOT_FOUND", "Event not found");
    }

    const context = await this.#getContext(calendarId);
    return this.#toEventModel(context, payload.Event);
  }

  async createEvent({ calendarId, event }) {
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

    // CalendarKeyPacket must be encrypted with the calendar public key (same as SharedKeyPacket).
    // CalendarEventContent is then encrypted with that same session key.
    const personalSessionKey = await openpgp.generateSessionKey({ encryptionKeys: context.calendarPublicKey });
    const personalKeyPacket = await openpgp.encryptSessionKey({
      encryptionKeys: context.calendarPublicKey,
      data: personalSessionKey.data,
      algorithm: personalSessionKey.algorithm,
      format: "binary",
    });
    const calendarEventContent = await this.#encodeCalendarEventContent(context, eventUid, personalSessionKey);

    const body = buildCreateSyncRequestBody({
      memberId: context.memberId,
      sharedKeyPacket: toBase64(sharedKeyPacket),
      sharedEventContent,
      personalKeyPacket: toBase64(personalKeyPacket),
      calendarEventContent,
      protected: event.protected,
    });

    const response = await this.#requestJSON(
      "PUT",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/sync`,
      { uid, body }
    );

    const created = assertSyncEventResponse(response);
    return this.#toEventModel(context, created);
  }

  async updateEvent({ calendarId, eventId, patch, scope = "series", occurrenceStart = null }) {
    const context = await this.#getContext(calendarId);
    const uid = context.uid;

    const existingPayload = await this.#requestJSON(
      "GET",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { uid }
    );
    const existing = existingPayload?.Event;
    if (!existing) {
      throw new ApiError(404, "NOT_FOUND", "Event not found");
    }

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

    const personalSessionKey = await resolveUpdateCalendarSessionKey({
      existingCalendarKeyPacket: existing.CalendarKeyPacket,
      decryptExistingSessionKey: async (calendarKeyPacketBase64) => this.#decryptCalendarSessionKey(context, calendarKeyPacketBase64),
    });
    const calendarEventContent = personalSessionKey
      ? await this.#encodeCalendarEventContent(context, merged.uid, personalSessionKey)
      : undefined;

    const effectiveProtected = typeof patch.protected === "boolean" ? patch.protected : (existing.IsOrganizer === 1);
    const body = buildUpdateSyncRequestBody({
      memberId: context.memberId,
      eventId,
      sharedEventContent,
      calendarEventContent,
      notifications: existing.Notifications || null,
      color: existing.Color || null,
      scope,
      occurrenceStart,
      protected: effectiveProtected,
    });

    const response = await this.#requestJSON(
      "PUT",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/sync`,
      { uid, body }
    );

    const updated = assertSyncEventResponse(response);
    return this.#toEventModel(context, updated);
  }

  async deleteEvent({ calendarId, eventId, scope = "series", occurrenceStart = null }) {
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

    const response = await this.#requestJSON(
      "PUT",
      `/api/calendar/v1/${encodeURIComponent(calendarId)}/events/sync`,
      { uid, body }
    );
    assertSyncDeleteResponse(response);
    return null;
  }

  async #fetchRangeRawEvents({ uid, calendarId, startUnix, endUnix, timezone, pageSize }) {
    const dedupe = new Map();
    const queryTypes = [0, 1, 2, 3];

    for (const type of queryTypes) {
      let page = 0;
      let more = true;
      while (more && page < 10) {
        const payload = await this.#requestJSON(
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
    }

    return [...dedupe.values()];
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

  async #encodeCalendarEventContent(context, uid, sessionKey) {
    // CalendarEventContent uses the same Type 2+3 structure as SharedEventContent.
    // The "personal" vCal must include UID + DTSTAMP at minimum.
    const dtstamp = formatVcalUtc(new Date());
    const signedPart = buildVcalendarVevent([["UID", uid], ["DTSTAMP", dtstamp]]);
    const encryptedPart = buildVcalendarVevent([["UID", uid], ["DTSTAMP", dtstamp]]);

    const signedSignature = await openpgp.sign({
      message: await openpgp.createMessage({ text: signedPart }),
      signingKeys: context.addressPrivateKey,
      detached: true,
      format: "armored",
    });

    const encryptedSignature = await openpgp.sign({
      message: await openpgp.createMessage({ text: encryptedPart }),
      signingKeys: context.addressPrivateKey,
      detached: true,
      format: "armored",
    });

    const encryptedBinary = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: encryptedPart }),
      sessionKey,
      format: "binary",
    });

    return [
      {
        Type: 2,
        Data: signedPart,
        Signature: signedSignature,
      },
      {
        Type: 3,
        Data: toBase64(encryptedBinary),
        Signature: encryptedSignature,
      },
    ];
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

  async #decryptCalendarSessionKey(context, calendarKeyPacketBase64) {
    return this.#decryptSessionKeyPacket({
      privateKey: context.calendarPrivateKey,
      packetBase64: calendarKeyPacketBase64,
      errorMessage: "Unable to decrypt event calendar session key",
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
    if (this.cachedUID) {
      return this.cachedUID;
    }

    const candidates = await this.sessionStore.getUIDCandidates();
    if (candidates.length === 0) {
      throw new ApiError(401, "UID_MISSING", "Cookie bundle does not include uidCandidates");
    }

    for (const candidate of candidates) {
      try {
        await this.#requestJSON("GET", "/api/core/v4/users", { uid: candidate, allowAuthFailure: false });
        this.cachedUID = candidate;
        return candidate;
      } catch {
        continue;
      }
    }

    throw new ApiError(401, "AUTH_EXPIRED", "Unable to authenticate with any UID candidate");
  }

  async #getContext(calendarId) {
    if (this.cachedContext?.calendarId === calendarId) {
      return this.cachedContext;
    }

    const uid = await this.#getUID();
    const persistedSessions = await this.sessionStore.getPersistedSessions();
    const persistedSession = findPersistedSession(persistedSessions, uid);
    if (!persistedSession?.blob) {
      throw new ApiError(
        401,
        "SESSION_BLOB_MISSING",
        "Persisted Proton session blob is missing; rerun cookie bootstrap"
      );
    }

    const localKeyPayload = await this.#requestJSON("GET", "/api/auth/v4/sessions/local/key", { uid });
    const keyPassword = await decryptPersistedSessionKeyPassword({
      clientKeyBase64: localKeyPayload?.ClientKey,
      persistedBlobBase64: persistedSession.blob,
    });

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
      memberId: member.ID,
      addressEmail: address.Email,
      addressPrivateKey,
      calendarPrivateKey,
      calendarPublicKey,
    };

    return this.cachedContext;
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
    const scopedMap = parseCookieHeaderToMap(scopedHeader);

    const bundleCookies = await this.#getBundleCookies();
    const fallbackMap = new Map();

    for (const cookie of bundleCookies) {
      const name = String(cookie?.name || "");
      if (!name) {
        continue;
      }

      if (name === `REFRESH-${uid}` || name === `AUTH-${uid}` || name === "Session-Id" || name === "Tag" || name === "Domain") {
        fallbackMap.set(name, String(cookie?.value || ""));
      }
    }

    const merged = new Map([...fallbackMap, ...scopedMap]);
    return mapToCookieHeader(merged);
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
    const cookies = await this.#getBundleCookies();
    const refreshCookies = cookies.filter((cookie) => typeof cookie.name === "string" && cookie.name.startsWith("REFRESH-"));
    if (refreshCookies.length === 0) {
      return null;
    }

    const selected =
      refreshCookies.find((cookie) => cookie.name === `REFRESH-${uid}`) ||
      refreshCookies.find((cookie) => String(cookie.name).includes(uid)) ||
      refreshCookies[0];

    const rawValue = String(selected?.value || "");
    if (!rawValue) {
      return null;
    }

    let decoded = rawValue;
    try {
      decoded = decodeURIComponent(rawValue);
    } catch {
      // keep raw fallback
    }

    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      ...parsed,
      UID: typeof parsed.UID === "string" && parsed.UID.length > 0 ? parsed.UID : uid,
      ResponseType: parsed.ResponseType || "token",
      GrantType: parsed.GrantType || "refresh_token",
    };
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
    // eslint-disable-next-line no-console
    console.log(`[proton-auth] ${message}${suffix}`);
  }

  async #requestJSON(method, pathname, options = {}) {
    const uid = options.uid || (await this.#getUID());
    const url = new URL(pathname, this.baseUrl);

    const query = options.query || {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, value);
    }

    const baseHeaders = {
      Accept: "application/vnd.protonmail.v1+json",
      "x-pm-appversion": this.appVersion,
      "x-pm-locale": this.locale,
      "x-pm-uid": uid,
      ...(options.extraHeaders || {}),
    };

    if (options.idempotencyKey) {
      baseHeaders["X-Idempotency-Key"] = options.idempotencyKey;
    }
    if (options.body !== undefined) {
      baseHeaders["Content-Type"] = "application/json";
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    let attempt = 0;
    let authRefreshAttempted = false;

    while (attempt <= this.maxRetries) {
      const isFinalAttempt = attempt === this.maxRetries;
      attempt += 1;

      try {
        const cookieHeader = await this.sessionStore.getCookieHeader(url.toString());
        if (!cookieHeader) {
          throw new ApiError(401, "AUTH_EXPIRED", "No valid session cookies available");
        }

        const response = await this.fetchImpl(url, {
          method,
          headers: {
            ...baseHeaders,
            Cookie: cookieHeader,
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        await this.#persistResponseCookies(url, response, `${method}:${pathname}`);
        const payload = await parseResponsePayload(response);

        if (response.status === 401 || response.status === 403) {
          if (options.allowAuthRefresh !== false && !authRefreshAttempted) {
            authRefreshAttempted = true;
            const refreshed = await this.#attemptAuthRefresh(uid);
            if (refreshed) {
              attempt -= 1;
              continue;
            }
          }

          if (options.allowRelogin !== false) {
            const relogged = await this.#attemptRelogin(uid, `${method}:${pathname}`);
            if (relogged) {
              attempt -= 1;
              continue;
            }
          }

          throw new ApiError(401, "AUTH_EXPIRED", "Proton session is expired or unauthorized");
        }

        if (response.status === 404) {
          throw new ApiError(404, "NOT_FOUND", "Resource not found");
        }

        if ((response.status === 429 || response.status >= 500) && !isFinalAttempt) {
          await delay(backoffMs(attempt));
          continue;
        }

        if (!response.ok) {
          throw new ApiError(response.status, "UPSTREAM_ERROR", "Upstream request failed", {
            status: response.status,
            payload,
          });
        }

        if (payload && typeof payload === "object" && typeof payload.Code === "number") {
          if (![1000, 1001].includes(payload.Code)) {
            throw new ApiError(502, "UPSTREAM_ERROR", payload.Error || "Unexpected upstream response", {
              payload,
            });
          }
        }

        return payload;
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }

        if (isFinalAttempt) {
          throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend", {
            message: error?.message,
          });
        }

        await delay(backoffMs(attempt));
      }
    }

    throw new ApiError(502, "UPSTREAM_UNREACHABLE", "Unable to reach Proton backend");
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
    this.cachedContext = null;
  }
}

function findPersistedSession(persistedSessions, uid) {
  const entries = Object.entries(persistedSessions || {});
  if (entries.length === 0) {
    return null;
  }

  for (const [, value] of entries) {
    if (value && typeof value === "object" && value.UID === uid && value.blob) {
      return value;
    }
  }

  for (const [, value] of entries) {
    if (value && typeof value === "object" && value.blob) {
      return value;
    }
  }

  return null;
}

async function decryptPersistedSessionKeyPassword({ clientKeyBase64, persistedBlobBase64 }) {
  if (!clientKeyBase64 || !persistedBlobBase64) {
    throw new ApiError(401, "SESSION_BLOB_MISSING", "Missing client key or persisted session blob");
  }

  const keyBytes = fromBase64(clientKeyBase64);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);

  const blobBytes = fromBase64(persistedBlobBase64);
  const iv = blobBytes.slice(0, 16);
  const ciphertext = blobBytes.slice(16);

  let decrypted;
  try {
    decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  } catch {
    throw new ApiError(401, "SESSION_BLOB_INVALID", "Unable to decrypt persisted session blob");
  }

  const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(decrypted)));
  const keyPassword = parsed?.keyPassword;
  if (typeof keyPassword !== "string" || keyPassword.length === 0) {
    throw new ApiError(401, "SESSION_BLOB_INVALID", "Persisted session does not contain keyPassword");
  }
  return keyPassword;
}

async function decryptAddressPassphrase({ token, signature, userPrivateKey, userPublicKey, fallbackPassphrase }) {
  if (!token) {
    return fallbackPassphrase;
  }

  const message = await openpgp.readMessage({ armoredMessage: token });
  const signatureObject = signature
    ? await openpgp.readSignature({ armoredSignature: signature }).catch(() => undefined)
    : undefined;

  const decrypted = await openpgp.decrypt({
    message,
    decryptionKeys: userPrivateKey,
    verificationKeys: userPublicKey,
    ...(signatureObject ? { signature: signatureObject } : {}),
    format: "utf8",
  });

  if (decrypted.signatures?.length > 0) {
    await decrypted.signatures[0].verified;
  }

  return String(decrypted.data);
}

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
  organizerEmail,
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

  const signedProperties = [
    ["UID", uid],
    ["DTSTAMP", dtstamp],
    [dtstartFormatted.key, dtstartFormatted.value],
    [dtendFormatted.key, dtendFormatted.value],
    ["ORGANIZER", `MAILTO:${organizerEmail}`],
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

export function buildCreateSyncRequestBody({ memberId, sharedKeyPacket, sharedEventContent, personalKeyPacket, calendarEventContent, protected: isProtected = true }) {
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
          ...(personalKeyPacket ? { CalendarKeyPacket: personalKeyPacket } : {}),
          ...(calendarEventContent ? { CalendarEventContent: calendarEventContent } : {}),
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
  calendarEventContent,
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
          ...(calendarEventContent ? { CalendarEventContent: calendarEventContent } : {}),
          Notifications: notifications,
          Color: color,
          ...(occurrenceStart ? { RecurrenceID: toUnix(occurrenceStart) } : {}),
        },
      },
    ],
  };
}

export async function resolveUpdateCalendarSessionKey({
  existingCalendarKeyPacket,
  decryptExistingSessionKey,
}) {
  if (existingCalendarKeyPacket) {
    return decryptExistingSessionKey(existingCalendarKeyPacket);
  }

  return null;
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

function buildVcalendarVevent(properties) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//proton-calendar-api//EN", "BEGIN:VEVENT"];
  for (const [key, value] of properties) {
    if (value === undefined || value === null || String(value) === "") {
      continue;
    }
    lines.push(`${key}:${value}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR", "");
  return lines.join("\r\n");
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

function parseVeventProperties(ics) {
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

function hasDateValueProperty(ics, propertyName) {
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

async function decryptSymmetricMessageUtf8(encryptedBase64, sessionKey) {
  const message = await openpgp.readMessage({ binaryMessage: fromBase64(encryptedBase64) });
  const result = await openpgp.decrypt({
    message,
    sessionKeys: [sessionKey],
    format: "utf8",
  });
  return String(result.data);
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

function parseVcalUtc(raw) {
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

function unescapeIcsText(value) {
  return String(value)
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsRecurrence(props) {
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

function readInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseCursor(cursor) {
  const parsed = Number(cursor || "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function toUnix(isoString) {
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "Invalid time range");
  }
  return Math.floor(ms / 1000);
}

function toBase64(input) {
  return Buffer.from(input).toString("base64");
}

function fromBase64(value) {
  return Uint8Array.from(Buffer.from(String(value), "base64"));
}

function assertSyncEventResponse(payload) {
  if (payload?.Code !== 1001 || !Array.isArray(payload?.Responses) || payload.Responses.length === 0) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Unexpected sync response payload", { payload });
  }

  const op = payload.Responses[0]?.Response;
  if (!op) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Missing sync operation response", { payload });
  }

  if (op.Code !== 1000) {
    throw new ApiError(502, "UPSTREAM_ERROR", op.Error || "Sync operation failed", {
      code: op.Code,
      details: op.Details,
    });
  }

  if (!op.Event) {
    throw new ApiError(502, "UPSTREAM_ERROR", "Missing event in sync response", { payload });
  }

  return op.Event;
}

function assertSyncDeleteResponse(payload) {
  if (![1000, 1001].includes(payload?.Code)) {
    throw new ApiError(502, "UPSTREAM_ERROR", payload?.Error || "Delete operation failed", { payload });
  }

  if (!Array.isArray(payload?.Responses)) {
    return;
  }

  for (const item of payload.Responses) {
    const op = item?.Response;
    if (op && op.Code !== 1000) {
      throw new ApiError(502, "UPSTREAM_ERROR", op.Error || "Delete operation failed", {
        code: op.Code,
        details: op.Details,
      });
    }
  }
}

function getSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values)) {
      return values.filter((value) => typeof value === "string" && value.length > 0);
    }
  }

  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }
  return [combined];
}

function flattenBundleCookies(bundle) {
  const rows = [];

  if (Array.isArray(bundle?.cookies)) {
    rows.push(...bundle.cookies);
  }

  if (bundle?.cookiesByDomain && typeof bundle.cookiesByDomain === "object") {
    for (const [domain, cookies] of Object.entries(bundle.cookiesByDomain)) {
      if (!Array.isArray(cookies)) {
        continue;
      }
      rows.push(...cookies.map((cookie) => ({ domain, ...cookie })));
    }
  }

  return rows.filter((cookie) => cookie && typeof cookie === "object");
}

function buildRefreshUrls(baseUrl, paths) {
  const urls = [];
  for (const pathname of paths) {
    urls.push(new URL(pathname, baseUrl).toString());
    urls.push(new URL(pathname, "https://account.proton.me").toString());
  }
  return [...new Set(urls)];
}

function parseCookieHeaderToMap(cookieHeader) {
  const map = new Map();
  if (!cookieHeader) {
    return map;
  }

  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }

    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (!name) {
      continue;
    }

    map.set(name, value);
  }

  return map;
}

function mapToCookieHeader(map) {
  const pairs = [];
  for (const [name, value] of map.entries()) {
    if (!name) {
      continue;
    }
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

function describeCookieChanges(changes) {
  return changes.map((change) => ({
    action: change.action,
    name: change.name,
    domain: change.domain,
    path: change.path,
    previousExpiresAt: formatExpiry(change.previousExpiresAt),
    nextExpiresAt: formatExpiry(change.nextExpiresAt),
  }));
}

function formatExpiry(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return new Date(value).toISOString();
}

function backoffMs(attempt) {
  return Math.min(1500, 120 * 2 ** attempt);
}

async function parseResponsePayload(response) {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
