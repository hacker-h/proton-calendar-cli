import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDotEnv } from "../src/env-file.js";

test("loads local .env and maps ProtonMail credential aliases", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-env-file-test-"));
  await writeFile(
    path.join(tmpDir, ".env"),
    [
      "PROTONMAIL_USERNAME=person@example.com",
      "PROTONMAIL_PASSWORD=dotenv-password",
      "PROTONMAIL_USERNAME2=second@example.com",
      "PROTONMAIL_PASSWORD2=second-dotenv-password",
      "PC_API_TOKEN=dotenv-token",
      "QUOTED_VALUE=\"line\\nvalue\"",
      "LITERAL_BACKSLASH_N=\"line\\\\nvalue\"",
      "UNQUOTED=value # comment",
      "",
    ].join("\n")
  );
  await chmod(path.join(tmpDir, ".env"), 0o600);

  const env = {
    PROTON_PASSWORD: "shell-password",
    PROTON_USERNAME2: "second-shell@example.com",
  };

  const result = loadDotEnv(env, { cwd: tmpDir });

  assert.equal(result.loaded, true);
  assert.equal(env.PROTONMAIL_USERNAME, "person@example.com");
  assert.equal(env.PROTON_USERNAME, "person@example.com");
  assert.equal(env.PROTONMAIL_PASSWORD, "dotenv-password");
  assert.equal(env.PROTON_PASSWORD, "shell-password");
  assert.equal(env.PROTONMAIL_USERNAME2, "second@example.com");
  assert.equal(env.PROTON_USERNAME2, "second-shell@example.com");
  assert.equal(env.PROTONMAIL_PASSWORD2, "second-dotenv-password");
  assert.equal(env.PROTON_PASSWORD2, "second-dotenv-password");
  assert.equal(env.PC_API_TOKEN, "dotenv-token");
  assert.equal(env.QUOTED_VALUE, "line\nvalue");
  assert.equal(env.LITERAL_BACKSLASH_N, "line\\nvalue");
  assert.equal(env.UNQUOTED, "value");
});

test("maps ProtonMail credential aliases without a .env file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-env-file-empty-test-"));
  const env = {
    PROTONMAIL_USERNAME: "person@example.com",
    PROTONMAIL_PASSWORD: "protonmail-password",
    PROTONMAIL_USERNAME2: "second@example.com",
    PROTONMAIL_PASSWORD2: "second-password",
  };

  const result = loadDotEnv(env, { cwd: tmpDir });

  assert.equal(result.loaded, false);
  assert.equal(env.PROTON_USERNAME, "person@example.com");
  assert.equal(env.PROTON_PASSWORD, "protonmail-password");
  assert.equal(env.PROTON_USERNAME2, "second@example.com");
  assert.equal(env.PROTON_PASSWORD2, "second-password");
});

test("shell ProtonMail aliases take precedence over dotenv canonical names", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-env-file-alias-precedence-test-"));
  await writeFile(
    path.join(tmpDir, ".env"),
    [
      "PROTON_USERNAME=dotenv@example.com",
      "PROTON_PASSWORD=dotenv-password",
      "PROTON_USERNAME2=dotenv-second@example.com",
      "PROTON_PASSWORD2=dotenv-second-password",
      "",
    ].join("\n")
  );
  await chmod(path.join(tmpDir, ".env"), 0o600);

  const env = {
    PROTONMAIL_USERNAME: "shell@example.com",
    PROTONMAIL_PASSWORD2: "shell-second-password",
  };

  loadDotEnv(env, { cwd: tmpDir });

  assert.equal(env.PROTON_USERNAME, "shell@example.com");
  assert.equal(env.PROTON_PASSWORD, "dotenv-password");
  assert.equal(env.PROTON_USERNAME2, "dotenv-second@example.com");
  assert.equal(env.PROTON_PASSWORD2, "shell-second-password");
});

test("rejects unsafe .env permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are not reliable on Windows");
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-env-file-permissions-test-"));
  await writeFile(path.join(tmpDir, ".env"), "PC_API_TOKEN=dotenv-token\n");
  await chmod(path.join(tmpDir, ".env"), 0o644);

  assert.throws(
    () => loadDotEnv({}, { cwd: tmpDir }),
    (error) => error?.code === "SECRET_FILE_UNSAFE_PERMISSIONS"
  );
});
