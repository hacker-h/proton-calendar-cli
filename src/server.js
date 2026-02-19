import http from "node:http";
import { randomUUID } from "node:crypto";
import { assertConfig } from "./config.js";
import { ApiError, isApiError, toErrorPayload } from "./errors.js";
import { ProtonCalendarClient } from "./proton/proton-client.js";
import { CalendarService } from "./service/calendar-service.js";
import { CookieSessionStore } from "./session/cookie-session-store.js";

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
      fetchImpl: options.fetchImpl,
    });
  const service =
    options.service ||
    new CalendarService({
      targetCalendarId: config.targetCalendarId,
      protonClient,
      sessionStore,
    });

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Request-Id", requestId);
      res.end(`${JSON.stringify(payload)}\n`);
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

      if (method === "GET" && url.pathname === "/v1/events") {
        send(
          200,
          {
            data: await service.listEvents({
              start: url.searchParams.get("start"),
              end: url.searchParams.get("end"),
              limit: url.searchParams.get("limit"),
              cursor: url.searchParams.get("cursor"),
            }),
          }
        );
        return;
      }

      const eventId = extractEventId(url.pathname);
      if (eventId && method === "GET") {
        send(200, { data: await service.getEvent(eventId) });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/events") {
        const body = await readJsonBody(req);
        send(
          201,
          {
            data: await service.createEvent(body, req.headers["x-idempotency-key"]),
          }
        );
        return;
      }

      if (eventId && method === "PATCH") {
        const body = await readJsonBody(req);
        send(
          200,
          {
            data: await service.updateEvent(eventId, body, req.headers["x-idempotency-key"]),
          }
        );
        return;
      }

      if (eventId && method === "DELETE") {
        send(
          200,
          {
            data: await service.deleteEvent(eventId, req.headers["x-idempotency-key"]),
          }
        );
        return;
      }

      throw new ApiError(404, "NOT_FOUND", "Route not found");
    } catch (error) {
      if (isApiError(error)) {
        send(error.status, toErrorPayload(error));
        return;
      }
      send(500, toErrorPayload(error));
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
  const port = options.port || config.port;

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
  if (token !== expectedToken) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid bearer token");
  }
}

function extractEventId(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "events") {
    return decodeURIComponent(parts[2]);
  }
  return null;
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 1024 * 1024) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    }
  }

  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}
