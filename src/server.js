import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { assertConfig } from "./config.js";
import { ApiError, isApiError, toErrorPayload } from "./errors.js";
import { ProtonCalendarClient } from "./proton/proton-client.js";
import { CalendarService } from "./service/calendar-service.js";
import { CookieSessionStore } from "./session/cookie-session-store.js";
import { MAX_ICS_EXPORT_EVENTS, MAX_ICS_IMPORT_BYTES, assertLocalIcsImportEventLimit, exportEventsToIcs, parseIcsEvents } from "./ics.js";

export function createApiServer(config, options = {}) {
  assertConfig(config);

  const sessionStore =
    options.sessionStore || new CookieSessionStore({ cookieBundlePath: config.cookieBundlePath });
  const protonClient =
    options.protonClient ||
    new ProtonCalendarClient({
      baseUrl: config.protonBaseUrl,
      sessionStore,
      timeoutMs: config.protonTimeoutMs,
      maxRetries: config.protonMaxRetries,
      debugAuth: config.protonAuthDebug,
      autoRelogin: config.protonAutoRelogin,
      reloginMode: config.protonReloginMode,
      reloginTimeoutMs: config.protonReloginTimeoutMs,
      reloginPollSeconds: config.protonReloginPollSeconds,
      reloginCooldownMs: config.protonReloginCooldownMs,
      recoveryLockPath: config.protonReloginLockPath,
      chromePath: config.protonChromePath,
      profileDir: config.protonProfileDir,
      loginUrl: config.protonReloginUrl,
      authManager: options.authManager,
      bootstrapRunner: options.bootstrapRunner,
      fetchImpl: options.fetchImpl,
    });
  const service =
    options.service ||
    new CalendarService({
      targetCalendarId: config.targetCalendarId,
      defaultCalendarId: config.defaultCalendarId,
      allowedCalendarIds: config.allowedCalendarIds,
      protonClient,
      sessionStore,
      recurrenceMaxIterations: config.recurrenceMaxIterations,
    });

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Request-Id", requestId);
      res.end(`${JSON.stringify(payload)}\n`);
    };
    const sendText = (status, contentType, text) => {
      res.statusCode = status;
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Request-Id", requestId);
      res.end(text);
    };

    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (method === "GET" && url.pathname === "/v1/health") {
        send(200, {
          data: {
            status: "ok",
            requestId,
          },
        });
        return;
      }

      assertAuthorized(req, config.apiBearerToken);

      if (method === "GET" && url.pathname === "/v1/auth/status") {
        send(200, { data: await service.authStatus() });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/calendars") {
        send(200, { data: await service.listCalendars() });
        return;
      }

      const icsRoute = parseIcsRoute(url.pathname);

      if (icsRoute && method === "GET") {
        const events = await listAllEventsForIcsExport(service, {
          start: url.searchParams.get("start"),
          end: url.searchParams.get("end"),
        }, {
          calendarId: icsRoute.calendarId,
        });
        sendText(200, "text/calendar; charset=utf-8", exportEventsToIcs(events));
        return;
      }

      if (icsRoute && method === "POST") {
        const ics = await readIcsBody(req);
        const parsed = parseIcsEvents(ics);
        assertLocalIcsImportEventLimit(parsed.count);
        service.validateCreateEvents(parsed.events, { calendarId: icsRoute.calendarId });
        const events = [];
        for (let index = 0; index < parsed.events.length; index += 1) {
          try {
            events.push(await service.createEvent(parsed.events[index], deriveImportIdempotencyKey(req.headers["x-idempotency-key"], index), {
              calendarId: icsRoute.calendarId,
            }));
          } catch (error) {
            if (events.length === 0) {
              throw error;
            }
            throw new ApiError(502, "ICS_IMPORT_PARTIAL_FAILURE", "ICS import stopped after creating some events; manual cleanup may be required", {
              imported: events.length,
              failedIndex: index,
              importedEventIds: events.map((event) => event.id),
              causeCode: isApiError(error) ? error.code : undefined,
            });
          }
        }
        send(201, {
          data: {
            imported: events.length,
            events,
          },
        });
        return;
      }

      const route = parseEventRoute(url.pathname);

      if (route?.kind === "collection" && method === "GET") {
        send(
          200,
          {
            data: await service.listEvents({
              start: url.searchParams.get("start"),
              end: url.searchParams.get("end"),
              limit: url.searchParams.get("limit"),
              cursor: url.searchParams.get("cursor"),
            }, {
              calendarId: route.calendarId,
            }),
          }
        );
        return;
      }

      if (route?.kind === "event" && method === "GET") {
        send(200, {
          data: await service.getEvent(route.eventId, {
            calendarId: route.calendarId,
          }),
        });
        return;
      }

      if (route?.kind === "collection" && method === "POST") {
        const body = await readJsonBody(req);
        send(
          201,
          {
            data: await service.createEvent(body, req.headers["x-idempotency-key"], {
              calendarId: route.calendarId,
            }),
          }
        );
        return;
      }

      if (route?.kind === "event" && method === "PATCH") {
        const body = await readJsonBody(req);
        send(
          200,
          {
            data: await service.updateEvent(route.eventId, body, req.headers["x-idempotency-key"], {
              calendarId: route.calendarId,
              scope: url.searchParams.get("scope"),
              occurrenceStart: url.searchParams.get("occurrenceStart"),
            }),
          }
        );
        return;
      }

      if (route?.kind === "event" && method === "DELETE") {
        send(
          200,
          {
            data: await service.deleteEvent(route.eventId, req.headers["x-idempotency-key"], {
              calendarId: route.calendarId,
              scope: url.searchParams.get("scope"),
              occurrenceStart: url.searchParams.get("occurrenceStart"),
            }),
          }
        );
        return;
      }

      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) {
      if (isApiError(error)) {
        send(error.status, toErrorPayload(error, { requestId }));
        return;
      }
      send(500, toErrorPayload(error, { requestId }));
    }
  });

  return {
    server,
    service,
    sessionStore,
    protonClient,
  };
}

export async function startApiServer(config, options = {}) {
  const app = createApiServer(config, options);
  const host = options.host || "127.0.0.1";
  const port = options.port ?? config.port;

  await new Promise((resolve, reject) => {
    app.server.listen(port, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = app.server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;

  return {
    ...app,
    baseUrl: `http://${host}:${resolvedPort}`,
    close: async () => {
      await new Promise((resolve, reject) => {
        app.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function assertAuthorized(req, expectedToken) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!isBearerTokenAuthorized(token, expectedToken)) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid bearer token");
  }
}

function isBearerTokenAuthorized(token, expectedToken) {
  const expected = Buffer.from(expectedToken, "utf8");
  const actual = Buffer.from(token, "utf8");
  const comparable = actual.length === expected.length ? actual : Buffer.alloc(expected.length);

  return timingSafeEqual(comparable, expected) && actual.length === expected.length;
}

function parseEventRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 2 && parts[0] === "v1" && parts[1] === "events") {
    return {
      kind: "collection",
      calendarId: null,
    };
  }

  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "events") {
    return {
      kind: "event",
      calendarId: null,
      eventId: decodeURIComponent(parts[2]),
    };
  }

  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "calendars" && parts[3] === "events") {
    return {
      kind: "collection",
      calendarId: decodeURIComponent(parts[2]),
    };
  }

  if (parts.length === 5 && parts[0] === "v1" && parts[1] === "calendars" && parts[3] === "events") {
    return {
      kind: "event",
      calendarId: decodeURIComponent(parts[2]),
      eventId: decodeURIComponent(parts[4]),
    };
  }

  return null;
}

function parseIcsRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "events" && parts[2] === "ics") {
    return { calendarId: null };
  }

  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "calendars" && parts[3] === "ics") {
    return { calendarId: decodeURIComponent(parts[2]) };
  }

  return null;
}

function deriveImportIdempotencyKey(value, index) {
  const raw = Array.isArray(value) ? value[0] : value;
  const key = String(raw || "").trim();
  return key ? `${key}:${index}` : undefined;
}

async function listAllEventsForIcsExport(service, input, options) {
  const listed = await service.listEventsForExport(input, options);
  if (listed.events.length > MAX_ICS_EXPORT_EVENTS) {
    throw new ApiError(422, "ICS_EXPORT_EVENT_LIMIT", "ICS export exceeded the 15000 event safety limit", {
      maxEvents: MAX_ICS_EXPORT_EVENTS,
    });
  }
  return listed.events;
}

async function readJsonBody(req) {
  const raw = await readRawBody(req, 1024 * 1024);

  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

async function readIcsBody(req) {
  const raw = await readRawBody(req, MAX_ICS_IMPORT_BYTES + 1024);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("text/calendar") || contentType.includes("text/plain")) {
    return raw;
  }
  if (raw.trim().length === 0) {
    throw new ApiError(400, "INVALID_PAYLOAD", "ICS import body is required");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.ics !== "string") {
      throw new Error("invalid payload");
    }
    return parsed.ics;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "ICS import JSON body must contain an ics string");
  }
}

async function readRawBody(req, maxBytes) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    }
  }
  return raw;
}
