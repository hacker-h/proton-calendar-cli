import http from "node:http";

export async function startMockProtonServer(options = {}) {
  const validSessionCookie = options.validSessionCookie || "valid-session";
  const accountName = options.accountName || "assistant";
  const userId = options.userId || "user-1";
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    requests.push({
      method: req.method || "GET",
      pathname: url.pathname,
      search: url.search,
      headers: { ...req.headers },
    });

    if (!isAuthorized(req.headers.cookie, validSessionCookie)) {
      send(res, 401, { Code: 2001, Error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/core/v4/users") {
      send(res, 200, {
        Code: 1000,
        User: {
          Name: accountName,
          ID: userId,
        },
      });
      return;
    }

    send(res, 404, { Code: 2500, Error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    validSessionCookie,
    baseUrl,
    requests() {
      return requests.map((request) => ({
        ...request,
        headers: { ...request.headers },
      }));
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
