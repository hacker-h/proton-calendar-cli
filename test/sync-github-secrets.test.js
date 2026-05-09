import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSyncGithubSecrets } from "../scripts/ci/sync-github-secrets.mjs";

test("locked git-crypt env file fails before setting GitHub secrets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-sync-secrets-locked-"));
  const envPath = path.join(tmpDir, "local-live.env");
  await writeFile(envPath, Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00, 0x01]));

  const calls = [];
  await assert.rejects(
    runSyncGithubSecrets({
      argv: [envPath],
      spawnImpl: createMockGh(calls),
      stdout: createWriter(),
    }),
    /git-crypt locked.*git-crypt unlock/
  );
  assert.deepEqual(calls, []);
});

test("plaintext env file syncs required and optional GitHub secrets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-sync-secrets-plain-"));
  const envPath = path.join(tmpDir, "local-live.env");
  await writeFile(
    envPath,
    [
      "PROTON_USERNAME=person@example.com",
      'PROTON_PASSWORD="correct horse battery staple"',
      "PROTON_TEST_CALENDAR_ID=calendar-1",
      "",
    ].join("\n")
  );

  const calls = [];
  const stdout = createWriter();
  await runSyncGithubSecrets({
    argv: [envPath],
    spawnImpl: createMockGh(calls),
    stdout,
  });

  assert.deepEqual(calls, [
    { command: "gh", args: ["secret", "set", "PROTON_USERNAME"], stdin: "person@example.com" },
    { command: "gh", args: ["secret", "set", "PROTON_PASSWORD"], stdin: "correct horse battery staple" },
    { command: "gh", args: ["secret", "set", "PROTON_TEST_CALENDAR_ID"], stdin: "calendar-1" },
  ]);
  assert.equal(
    stdout.value(),
    [
      "Set GitHub secret PROTON_USERNAME",
      "Set GitHub secret PROTON_PASSWORD",
      "Set GitHub secret PROTON_TEST_CALENDAR_ID",
      "",
    ].join("\n")
  );
});

test("missing required secret fails before setting GitHub secrets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-sync-secrets-missing-"));
  const envPath = path.join(tmpDir, "local-live.env");
  await writeFile(envPath, "PROTON_USERNAME=person@example.com\n");

  const calls = [];
  await assert.rejects(
    runSyncGithubSecrets({
      argv: [envPath],
      spawnImpl: createMockGh(calls),
      stdout: createWriter(),
    }),
    /PROTON_PASSWORD is missing/
  );
  assert.deepEqual(calls, []);
});

function createMockGh(calls) {
  return (command, args) => {
    const child = new EventEmitter();
    const call = { command, args, stdin: "" };
    calls.push(call);
    child.stderr = new EventEmitter();
    child.stdin = {
      end(value) {
        call.stdin = value;
        queueMicrotask(() => child.emit("close", 0));
      },
    };
    return child;
  };
}

function createWriter() {
  let output = "";
  return {
    write(chunk) {
      output += String(chunk);
    },
    value() {
      return output;
    },
  };
}
