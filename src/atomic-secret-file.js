import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_POLL_MS = 25;
const DEFAULT_LOCK_STALE_MS = 60000;

export async function withFileLock(targetPath, callback, options = {}) {
  const resolvedTarget = path.resolve(targetPath);
  const lockPath = options.lockPath || `${resolvedTarget}.lock`;
  const timeoutMs = readPositiveNumber(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = readPositiveNumber(options.pollMs, DEFAULT_LOCK_POLL_MS);
  const staleMs = readPositiveNumber(options.staleMs, DEFAULT_LOCK_STALE_MS);
  const now = options.now || (() => Date.now());

  await mkdir(path.dirname(lockPath), { recursive: true });
  const lock = await acquireFileLock({ lockPath, timeoutMs, pollMs, staleMs, now });

  try {
    return await callback();
  } finally {
    await lock.release();
  }
}

export async function writeSecretFileAtomic(filePath, contents, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tempPath = path.join(dir, `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(dir, { recursive: true });

  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    if (process.platform !== "win32") {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, resolvedPath);
    if (process.platform !== "win32") {
      await chmod(resolvedPath, 0o600);
    }
    if (options.fsyncDirectory !== false) {
      await fsyncDirectory(dir);
    }
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function acquireFileLock({ lockPath, timeoutMs, pollMs, staleMs, now }) {
  const deadline = now() + timeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`);
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") {
        await chmod(lockPath, 0o600);
      }
      return {
        release: async () => {
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockPath, staleMs, now)) {
        await rm(lockPath, { force: true });
        continue;
      }

      if (now() >= deadline) {
        const timeout = new Error(`Timed out waiting for file lock: ${lockPath}`);
        timeout.code = "FILE_LOCK_TIMEOUT";
        timeout.lockPath = lockPath;
        throw timeout;
      }

      await delay(pollMs);
    }
  }
}

async function readLockStartedAt(lockPath) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    const startedAt = Number(parsed?.startedAt);
    return Number.isFinite(startedAt) ? startedAt : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

async function isLockStale(lockPath, staleMs, now) {
  const currentTime = now();
  const startedAt = await readLockStartedAt(lockPath);
  if (Number.isFinite(startedAt)) {
    return currentTime - startedAt > staleMs;
  }

  try {
    const fileStat = await stat(lockPath);
    return currentTime - fileStat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function fsyncDirectory(dir) {
  let handle;
  try {
    handle = await open(dir, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
