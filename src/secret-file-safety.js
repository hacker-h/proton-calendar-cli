import { chmod, stat } from "node:fs/promises";

export const SECRET_FILE_UNSAFE_PERMISSIONS = "SECRET_FILE_UNSAFE_PERMISSIONS";

export async function assertSafeSecretFile(filePath, options = {}) {
  let fileStat = options.fileStat;
  if (!fileStat) {
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (options.required === false && error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  if (process.platform === "win32") {
    return fileStat;
  }

  if ((fileStat.mode & 0o077) !== 0) {
    const details = {
      path: filePath,
      mode: modeToString(fileStat.mode),
      expected: "0600",
    };
    const message = `Secret file has unsafe permissions: ${filePath}; expected owner-only permissions such as 0600`;
    throw options.createError
      ? options.createError(message, details)
      : Object.assign(new Error(message), { code: SECRET_FILE_UNSAFE_PERMISSIONS, details });
  }

  return fileStat;
}

export async function chmodOwnerOnly(filePath) {
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
  }
}

function modeToString(mode) {
  return `0${(mode & 0o777).toString(8)}`;
}
