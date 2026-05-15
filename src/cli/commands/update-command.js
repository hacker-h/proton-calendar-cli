import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { requireValue } from "../args.js";
import { CliError } from "../errors.js";

const GITHUB_API_BASE_URL = "https://api.github.com/repos/hacker-h/proton-calendar-cli";
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "pc-update";
const SUPPORTED_TARGETS = new Map([
  ["linux-x64", { platform: "linux", arch: "x64", asset: "pc-linux-x64" }],
  ["macos-arm64", { platform: "darwin", arch: "arm64", asset: "pc-macos-arm64" }],
  ["macos-x64", { platform: "darwin", arch: "x64", asset: "pc-macos-x64" }],
  ["windows-x64", { platform: "win32", arch: "x64", asset: "pc-windows-x64.exe" }],
]);

export async function runUpdateCommand(args, context) {
  const parsed = parseUpdateArgs(args);
  const runtime = readRuntime(context);
  await assertReleaseInstall(runtime.execPath);

  const target = targetFromRuntime(runtime.platform, runtime.arch);
  const release = await fetchRelease(context.fetchImpl, parsed.versionTag);
  const asset = findAsset(release, target.asset);
  const checksumAsset = findAsset(release, `${target.asset}.sha256`);
  const expectedHash = await fetchExpectedHash(context.fetchImpl, checksumAsset, target.asset);
  const currentHash = await hashFile(runtime.execPath);
  const updateAvailable = currentHash !== expectedHash;

  if (parsed.check || !updateAvailable) {
    return {
      output: "json",
      payload: {
        data: {
          update: updateAvailable ? "available" : "current",
          updateAvailable,
          version: release.tag_name,
          asset: asset.name,
          checksum: checksumAsset.name,
          currentSha256: currentHash,
          expectedSha256: expectedHash,
        },
      },
    };
  }

  const replacement = await downloadAsset(context.fetchImpl, asset);
  const actualHash = sha256(replacement);
  if (actualHash !== expectedHash) {
    throw new CliError("UPDATE_CHECKSUM_MISMATCH", `Downloaded ${asset.name} did not match ${checksumAsset.name}`, {
      asset: asset.name,
      expectedSha256: expectedHash,
      actualSha256: actualHash,
    });
  }

  await replaceBinary(runtime.execPath, replacement, {
    platform: runtime.platform,
    spawnImpl: context.spawnImpl || spawn,
    smokeBinary: context.smokeBinary,
  });

  return {
    output: "json",
    payload: {
      data: {
        update: runtime.platform === "win32" ? "scheduled" : "installed",
        updateAvailable: true,
        version: release.tag_name,
        asset: asset.name,
        checksum: checksumAsset.name,
        previousSha256: currentHash,
        installedSha256: expectedHash,
      },
    },
  };
}

function parseUpdateArgs(args) {
  const state = {
    check: false,
    versionTag: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--check") {
      state.check = true;
      continue;
    }
    if (token === "--version") {
      state.versionTag = normalizeTag(requireValue(args, ++i, token));
      continue;
    }
    throw new CliError("INVALID_ARGS", `Unknown update option: ${token}`);
  }

  return state;
}

function readRuntime(context) {
  return {
    execPath: path.resolve(context.execPath || process.execPath),
    platform: context.platform || process.platform,
    arch: context.arch || process.arch,
  };
}

async function assertReleaseInstall(execPath) {
  const basename = path.basename(execPath).toLowerCase();
  if (basename === "node" || basename === "node.exe") {
    throw new CliError("UPDATE_UNSUPPORTED", "pc update only supports standalone release binaries, not npm/source installs.");
  }
  if (!(basename === "pc" || basename === "pc.exe" || basename.startsWith("pc-"))) {
    throw new CliError("UPDATE_UNSUPPORTED", "pc update only supports release-installed pc binaries.", { execPath });
  }

  let linkInfo;
  try {
    linkInfo = await lstat(execPath);
  } catch (error) {
    throw new CliError("UPDATE_UNSUPPORTED", `Unable to inspect current executable: ${execPath}`, { code: error?.code });
  }
  if (linkInfo.isSymbolicLink()) {
    throw new CliError("UPDATE_UNSUPPORTED", "pc update does not replace symlinked binaries. Update the real release binary instead.", { execPath });
  }
}

function targetFromRuntime(platform, arch) {
  for (const config of SUPPORTED_TARGETS.values()) {
    if (config.platform === platform && config.arch === arch) {
      return config;
    }
  }
  throw new CliError("UPDATE_UNSUPPORTED", `No release binary is available for ${platform}/${arch}`);
}

async function fetchRelease(fetchImpl, versionTag) {
  const pathPart = versionTag ? `/releases/tags/${encodeURIComponent(versionTag)}` : "/releases/latest";
  const payload = await fetchJson(fetchImpl, `${GITHUB_API_BASE_URL}${pathPart}`);
  if (!payload || typeof payload !== "object" || typeof payload.tag_name !== "string" || !Array.isArray(payload.assets)) {
    throw new CliError("UPDATE_FAILED", "GitHub release response did not include release assets");
  }
  return payload;
}

function findAsset(release, name) {
  const asset = release.assets.find((candidate) => candidate?.name === name);
  if (!asset?.browser_download_url) {
    throw new CliError("UPDATE_FAILED", `Release ${release.tag_name} does not include ${name}`, { version: release.tag_name });
  }
  return asset;
}

async function fetchExpectedHash(fetchImpl, checksumAsset, binaryName) {
  const text = await fetchText(fetchImpl, checksumAsset.browser_download_url);
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (!match) {
      continue;
    }
    if (match[2].trim() === binaryName) {
      return match[1].toLowerCase();
    }
  }
  throw new CliError("UPDATE_FAILED", `${checksumAsset.name} did not include a checksum for ${binaryName}`);
}

async function downloadAsset(fetchImpl, asset) {
  const data = Buffer.from(await fetchArrayBuffer(fetchImpl, asset.browser_download_url));
  if (Number.isFinite(asset.size) && asset.size > 0 && data.length !== asset.size) {
    throw new CliError("UPDATE_FAILED", `Downloaded ${asset.name} size did not match GitHub metadata`, {
      expectedBytes: asset.size,
      actualBytes: data.length,
    });
  }
  return data;
}

async function replaceBinary(execPath, replacement, options) {
  const executableDir = path.dirname(execPath);
  const executableName = path.basename(execPath);
  const marker = `${process.pid}.${Date.now()}`;
  const tempPath = path.join(executableDir, `.${executableName}.${marker}.new`);
  const backupPath = path.join(executableDir, `.${executableName}.${marker}.old`);
  const currentStat = await stat(execPath);
  let replaced = false;
  if (options.platform === "win32") {
    assertWindowsHelperPathsSafe([execPath, tempPath, backupPath]);
  }

  try {
    await writeFile(tempPath, replacement, { mode: currentStat.mode & 0o777 });
    if (options.platform !== "win32") {
      await chmod(tempPath, currentStat.mode & 0o777);
    }
    await smokeDownloadedBinary(tempPath, options.smokeBinary);

    if (options.platform === "win32") {
      await scheduleWindowsReplace(execPath, tempPath, backupPath, options.spawnImpl);
      replaced = true;
      return;
    }

    await rename(tempPath, execPath);
    replaced = true;
  } catch (error) {
    if (!replaced) {
      await unlink(tempPath).catch(() => {});
    }
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("UPDATE_FAILED", `Unable to replace ${execPath}`, { code: error?.code });
  }
}

async function scheduleWindowsReplace(execPath, tempPath, backupPath, spawnImpl) {
  const scriptPath = `${tempPath}.cmd`;
  await writeFile(scriptPath, windowsReplaceScript(), "utf8");
  const command = [scriptPath, execPath, tempPath, backupPath].map(quoteWindowsArg).join(" ");
  const child = spawnImpl(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
}

function quoteWindowsArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertWindowsHelperPathsSafe(values) {
  for (const value of values) {
    if (/[%!^&|<>\r\n]/.test(value)) {
      throw new CliError("UPDATE_UNSUPPORTED", "pc update cannot safely run the Windows replacement helper from this install path.", {
        execPath: values[0],
      });
    }
  }
}

function windowsReplaceScript() {
  return `@echo off\r\nsetlocal\r\nset "OLD=%~1"\r\nset "NEW=%~2"\r\nset "BACKUP=%~3"\r\nfor /l %%i in (1,1,60) do (\r\n  move /y "%OLD%" "%BACKUP%" >nul 2>nul && goto replace_new\r\n  timeout /t 1 /nobreak >nul\r\n)\r\nexit /b 1\r\n:replace_new\r\nmove /y "%NEW%" "%OLD%" >nul 2>nul || (move /y "%BACKUP%" "%OLD%" >nul 2>nul & exit /b 1)\r\ndel /f /q "%BACKUP%" >nul 2>nul\r\ndel /f /q "%~f0" >nul 2>nul\r\nexit /b 0\r\n`;
}

async function smokeDownloadedBinary(file, smokeBinary) {
  if (smokeBinary) {
    await smokeBinary(file);
    return;
  }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync(file, ["--help"], { windowsHide: true, maxBuffer: 1024 * 1024 * 5 });
    if (!String(result.stdout || "").includes("pc - Proton Calendar CLI")) {
      throw new Error("Unexpected help output");
    }
  } catch (error) {
    throw new CliError("UPDATE_FAILED", `Downloaded ${path.basename(file)} did not pass smoke check`, { message: error?.message });
  }
}

async function fetchJson(fetchImpl, url) {
  const text = await fetchText(fetchImpl, url, { Accept: "application/vnd.github+json" });
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError("UPDATE_FAILED", "GitHub response was not valid JSON");
  }
}

async function fetchText(fetchImpl, url, headers = {}) {
  const response = await fetchWithHeaders(fetchImpl, url, headers);
  return response.text();
}

async function fetchArrayBuffer(fetchImpl, url) {
  const response = await fetchWithHeaders(fetchImpl, url, { Accept: "application/octet-stream" });
  return response.arrayBuffer();
}

async function fetchWithHeaders(fetchImpl, url, headers) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...headers,
      },
    });
  } catch (error) {
    throw new CliError("UPDATE_FAILED", "Unable to reach GitHub releases", { message: error?.message });
  }
  if (!response?.ok) {
    throw new CliError("UPDATE_FAILED", `GitHub release request failed (${response?.status || "unknown"})`);
  }
  return response;
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeTag(value) {
  const tag = String(value || "").trim();
  return tag.startsWith("v") ? tag : `v${tag}`;
}
