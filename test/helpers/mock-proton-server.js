import http from "node:http";

export async function startMockProtonServer(options = {}) {
  const calendarId = options.calendarId || "assistant-calendar";
  const validSessionCookie = options.validSessionCookie || "valid-session";
  const events = new Map();
  let nextId = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (!isAuthorized(req.headers.cookie, validSessionCookie)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/v1/auth/status") {
      send(res, 200, { data: { ok: true, account: "assistant" } });
      return;
    }

    if (req.method === "GET" && url.pathname === `/api/v1/calendars/${encodeURIComponent(calendarId)}/events`) {
      const start = Date.parse(url.searchParams.get("start") || "");
      const end = Date.parse(url.searchParams.get("end") || "");
      const limit = Number(url.searchParams.get("limit") || "50");
      const cursor = Number(url.searchParams.get("cursor") || "0");

      const filtered = [...events.values()]
        .filter((event) => {
          const eventStart = Date.parse(event.start);
          return !Number.isNaN(start) && !Number.isNaN(end) && eventStart >= start && eventStart < end;
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + limit < filtered.length ? String(cursor + limit) : null;
      send(res, 200, { data: { events: page, nextCursor } });
      return;
    }

    if (req.method === "POST" && url.pathname === `/api/v1/calendars/${encodeURIComponent(calendarId)}/events`) {
      const body = await readJsonBody(req);
      const id = `evt-${nextId}`;
      nextId += 1;

      const now = new Date().toISOString();
      const event = {
        id,
        calendarId,
        title: body.title,
        description: body.description || "",
        start: body.start,
        end: body.end,
        timezone: body.timezone,
        location: body.location || "",
        createdAt: now,
        updatedAt: now,
      };

      events.set(id, event);
      send(res, 201, { data: event });
      return;
    }

    const eventRoute = /^\/api\/v1\/calendars\/[^/]+\/events\/([^/]+)$/.exec(url.pathname);
    if (!eventRoute) {
      send(res, 404, { error: "not_found" });
      return;
    }

    const eventId = decodeURIComponent(eventRoute[1]);
    const existing = events.get(eventId);

    if (req.method === "GET") {
      if (!existing) {
        send(res, 404, { error: "not_found" });
        return;
      }
      send(res, 200, { data: existing });
      return;
    }

    if (req.method === "PATCH") {
      if (!existing) {
        send(res, 404, { error: "not_found" });
        return;
      }

      const patch = await readJsonBody(req);
      const updated = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };

      events.set(eventId, updated);
      send(res, 200, { data: updated });
      return;
    }

    if (req.method === "DELETE") {
      if (!existing) {
        send(res, 404, { error: "not_found" });
        return;
      }

      events.delete(eventId);
      send(res, 204, null);
      return;
    }

    send(res, 405, { error: "method_not_allowed" });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    calendarId,
    validSessionCookie,
    baseUrl,
    addEvent(event) {
      const id = event.id || `evt-${nextId++}`;
      const now = new Date().toISOString();
      const record = {
        id,
        calendarId,
        title: event.title || "seed",
        description: event.description || "",
        start: event.start,
        end: event.end,
        timezone: event.timezone || "UTC",
        location: event.location || "",
        createdAt: now,
        updatedAt: now,
      };
      events.set(id, record);
      return record;
    },
    eventCount() {
      return events.size;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
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

function send(res, status, payload) {
  res.statusCode = status;
  if (payload === null) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(`${JSON.stringify(payload)}\n`);
}

function isAuthorized(cookieHeader, expectedCookieValue) {
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return false;
  }

  const pairs = cookieHeader.split(";").map((part) => part.trim());
  return pairs.some((pair) => pair === `pm-session=${expectedCookieValue}`);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}
