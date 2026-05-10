import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

test("session generation advances after reloads and cookie writes", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-generation-test-"));
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

  const store = new CookieSessionStore({ cookieBundlePath: bundlePath });
  const initialGeneration = await store.getGeneration();

  await store.applySetCookieHeaders(
    "https://calendar.proton.me/api/auth/refresh",
    ["AUTH-uid-1=new-value; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly"]
  );
  const writeGeneration = await store.getGeneration();

  await store.invalidate();
  const reloadGeneration = await store.getGeneration();

  assert.equal(initialGeneration, 1);
  assert.equal(writeGeneration, 2);
  assert.equal(reloadGeneration, 3);
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

test("concurrent cookie bundle writes merge without clobbering", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-concurrent-test-"));
  const bundlePath = path.join(tmpDir, "cookies.json");
  await writeBundle(bundlePath, {
    cookies: [
      {
        name: "AUTH-uid-base",
        value: "base",
        domain: "calendar.proton.me",
        path: "/api/",
        secure: true,
      },
    ],
  });

  await Promise.all([
    runCookieWriter(bundlePath, "AUTH-uid-a", "value-a"),
    runCookieWriter(bundlePath, "AUTH-uid-b", "value-b"),
    runCookieWriter(bundlePath, "AUTH-uid-c", "value-c"),
  ]);

  const onDisk = JSON.parse(await readFile(bundlePath, "utf8"));
  const valuesByName = new Map(onDisk.cookies.map((cookie) => [cookie.name, cookie.value]));
  assert.equal(valuesByName.get("AUTH-uid-base"), "base");
  assert.equal(valuesByName.get("AUTH-uid-a"), "value-a");
  assert.equal(valuesByName.get("AUTH-uid-b"), "value-b");
  assert.equal(valuesByName.get("AUTH-uid-c"), "value-c");
});

test("stale cookie bundle write locks are removed and retried", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-stale-lock-test-"));
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
  await writeFile(`${bundlePath}.lock`, `${JSON.stringify({ pid: 999999, startedAt: 1_000 })}\n`, { mode: 0o600 });

  const store = new CookieSessionStore({
    cookieBundlePath: bundlePath,
    now: () => 120_000,
    lockStaleMs: 60_000,
  });
  const changes = await store.applySetCookieHeaders(
    "https://calendar.proton.me/api/auth/refresh",
    ["AUTH-uid-1=new; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly"]
  );

  assert.equal(changes.length, 1);
  await assert.rejects(() => stat(`${bundlePath}.lock`), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(bundlePath, "utf8")).cookies[0].value, "new");
});

test("failed atomic writes leave existing cookie bundle valid", async (t) => {
  if (process.platform === "win32") {
    t.skip("directory permissions are not reliable on Windows");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-atomic-failure-test-"));
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
  const before = await readFile(bundlePath, "utf8");
  await chmod(tmpDir, 0o500);

  try {
    const store = new CookieSessionStore({ cookieBundlePath: bundlePath });
    await assert.rejects(() => store.applySetCookieHeaders(
      "https://calendar.proton.me/api/auth/refresh",
      ["AUTH-uid-1=new; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly"]
    ));
  } finally {
    await chmod(tmpDir, 0o700);
  }

  assert.deepEqual(JSON.parse(await readFile(bundlePath, "utf8")), JSON.parse(before));
  const entries = await readdir(tmpDir);
  assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
});

test("cookie bundle writes preserve owner-only permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not reliable on Windows");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cookie-store-mode-test-"));
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

  const store = new CookieSessionStore({ cookieBundlePath: bundlePath });
  await store.applySetCookieHeaders(
    "https://calendar.proton.me/api/auth/refresh",
    ["AUTH-uid-1=new; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly"]
  );

  assert.equal((await stat(bundlePath)).mode & 0o777, 0o600);
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

async function runCookieWriter(bundlePath, name, value) {
  const script = `
    import { CookieSessionStore } from ${JSON.stringify(new URL("../src/session/cookie-session-store.js", import.meta.url).href)};
    const [bundlePath, name, value] = process.argv.slice(1);
    const store = new CookieSessionStore({ cookieBundlePath: bundlePath, lockTimeoutMs: 10000, lockPollMs: 5 });
    await store.applySetCookieHeaders(
      "https://calendar.proton.me/api/auth/refresh",
      [name + "=" + value + "; Path=/api/; Domain=calendar.proton.me; Expires=Wed, 30 Dec 2099 00:00:00 GMT; Secure; HttpOnly"]
    );
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, bundlePath, name, value], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
}
