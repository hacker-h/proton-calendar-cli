import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScriptPath = path.join(repoRoot, "scripts", "install.sh");

test("install script installs latest Linux release asset with checksum verification", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-install-script-linux-"));
  try {
    const releaseDir = path.join(tmpDir, "release");
    const installDir = path.join(tmpDir, "bin");
    const toolsDir = await createFakeTools(tmpDir, { osName: "Linux", archName: "x86_64" });
    await createReleaseAsset(releaseDir, "pc-linux-x64");

    const result = await runInstall(tmpDir, toolsDir, releaseDir, ["--dir", installDir]);
    assert.match(result.stdout, /Installed pc to /);

    const installed = path.join(installDir, "pc");
    await access(installed);
    const help = await execFileAsync(installed, ["--help"]);
    assert.match(help.stdout, /pc - Proton Calendar CLI/);

    const curlLog = await readFile(path.join(tmpDir, "curl.log"), "utf8");
    assert.match(curlLog, /\/latest\/download\/pc-linux-x64\n/);
    assert.match(curlLog, /\/latest\/download\/pc-linux-x64\.sha256\n/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("install script supports pinned macOS Apple Silicon release tags", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-install-script-macos-"));
  try {
    const releaseDir = path.join(tmpDir, "release");
    const installDir = path.join(tmpDir, "bin");
    const toolsDir = await createFakeTools(tmpDir, { osName: "Darwin", archName: "arm64" });
    await createReleaseAsset(releaseDir, "pc-macos-arm64");

    await runInstall(tmpDir, toolsDir, releaseDir, ["--version", "1.10.0", "--dir", installDir]);

    const curlLog = await readFile(path.join(tmpDir, "curl.log"), "utf8");
    assert.match(curlLog, /\/download\/v1\.10\.0\/pc-macos-arm64\n/);
    assert.match(curlLog, /\/download\/v1\.10\.0\/pc-macos-arm64\.sha256\n/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("install script refuses Windows shell environments", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-install-script-windows-"));
  try {
    const releaseDir = path.join(tmpDir, "release");
    const installDir = path.join(tmpDir, "bin");
    const toolsDir = await createFakeTools(tmpDir, { osName: "MSYS_NT-10.0", archName: "x86_64" });

    const failure = await installFailure(tmpDir, toolsDir, releaseDir, ["--dir", installDir]);
    assert.match(failure.stderr, /Windows is not supported by this POSIX installer/);

    await assert.rejects(access(path.join(installDir, "pc")), { code: "ENOENT" });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("install script refuses checksum mismatches before installing", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-install-script-checksum-"));
  try {
    const releaseDir = path.join(tmpDir, "release");
    const installDir = path.join(tmpDir, "bin");
    const toolsDir = await createFakeTools(tmpDir, { osName: "Linux", archName: "x86_64" });
    await createReleaseAsset(releaseDir, "pc-linux-x64", { checksum: "0".repeat(64) });

    const failure = await installFailure(tmpDir, toolsDir, releaseDir, ["--dir", installDir]);
    assert.match(failure.stderr, /checksum mismatch for pc-linux-x64/);

    await assert.rejects(access(path.join(installDir, "pc")), { code: "ENOENT" });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

async function runInstall(tmpDir, toolsDir, releaseDir, args) {
  return execFileAsync("sh", [installScriptPath, ...args], {
    cwd: tmpDir,
    env: installEnv(toolsDir, releaseDir, tmpDir),
    maxBuffer: 1024 * 1024,
  });
}

async function installFailure(tmpDir, toolsDir, releaseDir, args) {
  try {
    await runInstall(tmpDir, toolsDir, releaseDir, args);
  } catch (error) {
    return error;
  }
  throw new Error("install unexpectedly succeeded");
}

function installEnv(toolsDir, releaseDir, tmpDir) {
  return {
    ...process.env,
    HOME: path.join(tmpDir, "home"),
    PATH: `${toolsDir}${path.delimiter}${process.env.PATH}`,
    PC_INSTALL_BASE_URL: "https://example.test/releases",
    RELEASE_DIR: releaseDir,
    CURL_LOG: path.join(tmpDir, "curl.log"),
  };
}

async function createFakeTools(tmpDir, { osName, archName }) {
  const toolsDir = path.join(tmpDir, "tools");
  await mkdir(toolsDir, { recursive: true });
  await writeExecutable(
    path.join(toolsDir, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf '%s\n' '${osName}' ;;
  -m) printf '%s\n' '${archName}' ;;
  *) printf '%s\n' '${osName}' ;;
esac
`,
  );
  await writeExecutable(
    path.join(toolsDir, "curl"),
    `#!/bin/sh
url=
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      out=$2
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      url=$1
      shift
      ;;
  esac
done
[ -n "$url" ] || exit 2
[ -n "$out" ] || exit 2
name=\${url##*/}
printf '%s\n' "$url" >> "$CURL_LOG"
cp "$RELEASE_DIR/$name" "$out"
`,
  );
  return toolsDir;
}

async function createReleaseAsset(releaseDir, assetName, options = {}) {
  await mkdir(releaseDir, { recursive: true });
  const assetPath = path.join(releaseDir, assetName);
  const asset = `#!/bin/sh
if [ "$1" = "--help" ]; then
  printf '%s\n' 'pc - Proton Calendar CLI'
  exit 0
fi
printf '%s\n' 'fake pc'
`;
  await writeExecutable(assetPath, asset);
  const checksum = options.checksum || createHash("sha256").update(asset).digest("hex");
  await writeFile(path.join(releaseDir, `${assetName}.sha256`), `${checksum}  ${assetName}\n`, "utf8");
}

async function writeExecutable(file, content) {
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
}
