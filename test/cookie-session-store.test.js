import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CookieSessionStore } from "../src/session/cookie-session-store.js";

test("applySetCookieHeaders updates AUTH cookie expiry and value", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-test-"));
  const bundlePath = path.join(tmpDir, "cookies.json");
  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "old",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
        expires: Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000),
      },
    ],
  });

  const store = new CookieSessionStore({
    cookieBundlePath: bundlePath,
  });

  const changes = await store.applySetCookieHeaders(
    "https://calendar.proton.me/api/auth/refresh",
    [
      "AUTH-uid-1=new-value; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly; SameSite=None",
    ]
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "AUTH-uid-1");
  assert.equal(changes[0].action, "updated");
  assert.equal(changes[0].nextExpiresAt > changes[0].previousExpiresAt, true);

  const header = await store.getCookieHeader("https://calendar.proton.me/api/core/v4/users");
  assert.equal(header.includes("AUTH-uid-1=new-value"), true);

  const diagnostics = await store.getAuthCookieDiagnostics();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].name, "AUTH-uid-1");
  assert.equal(typeof diagnostics[0].expiresAt, "number");

  const onDisk = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(Array.isArray(onDisk.cookies), true);
  assert.equal(onDisk.cookies[0].value, "new-value");
});

test("applySetCookieHeaders removes cookies with max-age 0", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-remove-test-"));
  const bundlePath = path.join(tmpDir, "cookies.json");
  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "old",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
      },
    ],
  });

  const store = new CookieSessionStore({
    cookieBundlePath: bundlePath,
  });

  const changes = await store.applySetCookieHeaders(
    "https://calendar.proton.me/api/auth/refresh",
    ["AUTH-uid-1=; Path=/api/; Domain=calendar.proton.me; Max-Age=0; Secure; HttpOnly" ]
  );

  assert.equal(changes.length, 1);
  assert.equal(changes[0].action, "removed");

  const header = await store.getCookieHeader("https://calendar.proton.me/api/core/v4/users");
  assert.equal(header.includes("AUTH-uid-1"), false);
});

test("invalidate reloads updated cookies from disk", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-invalidate-test-"));
  const bundlePath = path.join(tmpDir, "cookies.json");
  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "old-value",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
      },
    ],
  });

  const store = new CookieSessionStore({
    cookieBundlePath: bundlePath,
  });

  let header = await store.getCookieHeader("https://calendar.proton.me/api/core/v4/users");
  assert.equal(header.includes("AUTH-uid-1=old-value"), true);

  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "new-value",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
      },
    ],
  });

  await store.invalidate();

  header = await store.getCookieHeader("https://calendar.proton.me/api/core/v4/users");
  assert.equal(header.includes("AUTH-uid-1=new-value"), true);
});

test("unsafe cookie bundle permissions are rejected", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not reliable on Windows");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-permissions-test-"));
  const bundlePath = path.join(tmpDir, "cookies.json");
  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-1",
        value: "value",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
      },
    ],
  });
  await chmod(bundlePath, 0o644);

  const store = new CookieSessionStore({ cookieBundlePath: bundlePath });
  await assert.rejects(
    () => store.getCookieHeader("https://calendar.proton.me/api/core/v4/users"),
    (error) => error?.code === "SECRET_FILE_UNSAFE_PERMISSIONS" && error?.status === 401
  );
});

async function writeBundle(filePath, payload) {
  await writeFile(
    filePath,
    `${JSON.stringify({
      exportedAt: new Date().toISOString(),
      source: "test",
      ...payload,
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
}
