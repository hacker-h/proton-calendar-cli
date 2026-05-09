import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/ci/sync-github-secrets.mjs", import.meta.url));
const gitCryptLockedFileMagic = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00]);

test("sync-github-secrets rejects git-crypt locked env files before gh runs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sync-github-secrets-locked-"));
  const envFilePath = path.join(tmpDir, "local-live.env");
  const ghLogPath = path.join(tmpDir, "gh-invocations.txt");
  await writeFile(
    envFilePath,
    Buffer.concat([gitCryptLockedFileMagic, Buffer.from("PROTON_USERNAME=alice\nPROTON_PASSWORD=secret\n")])
  );
  await writeFakeGh(tmpDir, ghLogPath);

  const result = await runScript(envFilePath, tmpDir);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, new RegExp(escapeRegExp(envFilePath)));
  assert.match(result.stderr, /git-crypt unlock before syncing GitHub secrets/);
  await assert.rejects(readFile(ghLogPath, "utf8"));
});

test("sync-github-secrets still invokes gh for plaintext env files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sync-github-secrets-plain-"));
  const envFilePath = path.join(tmpDir, "local-live.env");
  const ghLogPath = path.join(tmpDir, "gh-invocations.txt");
  await writeFile(
    envFilePath,
    [
      "PROTON_USERNAME=alice",
      "PROTON_PASSWORD=secret",
      "PROTON_TEST_CALENDAR_ID=cal-123",
      "",
    ].join("\n")
  );
  await writeFakeGh(tmpDir, ghLogPath);

  const result = await runScript(envFilePath, tmpDir);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Set GitHub secret PROTON_USERNAME/);
  assert.match(result.stdout, /Set GitHub secret PROTON_PASSWORD/);
  assert.match(result.stdout, /Set GitHub secret PROTON_TEST_CALENDAR_ID/);

  const ghLog = await readFile(ghLogPath, "utf8");
  assert.deepEqual(ghLog.trim().split("\n"), [
    "secret set PROTON_USERNAME",
    "secret set PROTON_PASSWORD",
    "secret set PROTON_TEST_CALENDAR_ID",
  ]);
});

async function runScript(envFilePath, tmpDir) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, envFilePath], {
      env: {
        ...process.env,
        PATH: `${tmpDir}${path.delimiter}${process.env.PATH || ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function writeFakeGh(tmpDir, ghLogPath) {
  const ghPath = path.join(tmpDir, "gh");
  await writeFile(
    ghPath,
    `#!/bin/sh
printf '%s %s %s\n' "$1" "$2" "$3" >> ${JSON.stringify(ghLogPath)}
cat >/dev/null
`
  );
  await chmod(ghPath, 0o755);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
