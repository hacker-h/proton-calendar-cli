import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-package-smoke-"));

try {
  const packDir = path.join(tmpDir, "pack");
  const installDir = path.join(tmpDir, "install");
  await mkdir(packDir, { recursive: true });
  await mkdir(installDir, { recursive: true });

  const { stdout } = await execFileCrossPlatform("pnpm", ["pack", "--pack-destination", packDir], { cwd: repoRoot });
  const tarballName = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!tarballName || !tarballName.endsWith(".tgz")) {
    throw new Error(`Unable to determine packed tarball from pnpm output: ${stdout}`);
  }

  await writeFile(path.join(installDir, "package.json"), '{"private":true,"type":"module"}\n');
  const tarballPath = path.join(packDir, path.basename(tarballName));
  await access(tarballPath);

  await execFileCrossPlatform("npm", ["install", "--engine-strict", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], {
    cwd: installDir,
  });

  await assertInstalledPackageFiles(installDir);
  await assertInstalledPackageMetadata(installDir);

  const help = await execPackageBin(installDir, ["--help"]);
  if (!help.stdout.includes("pc - Proton Calendar CLI")) {
    throw new Error("Packaged pc binary did not print expected help text");
  }

  let lsFailure = null;
  try {
    await execPackageBin(installDir, ["ls"]);
  } catch (error) {
    lsFailure = error;
  }
  if (!lsFailure) {
    throw new Error("Packaged pc ls unexpectedly succeeded without CLI config");
  }
  if (lsFailure.code !== 1 || !String(lsFailure.stderr || "").includes('"code": "CONFIG_ERROR"')) {
    throw new Error(`Packaged pc ls did not emit expected config error: ${lsFailure.stderr || lsFailure.message}`);
  }
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

async function assertInstalledPackageFiles(installDir) {
  const packageDir = path.join(installDir, "node_modules", "proton-calendar-cli");
  for (const expected of [
    "package.json",
    path.join("src", "cli.js"),
    path.join("src", "index.js"),
    path.join("scripts", "bootstrap-proton-cookies.mjs"),
  ]) {
    try {
      await access(path.join(packageDir, expected));
    } catch {
      throw new Error(`Installed package is missing required file: ${expected}`);
    }
  }
}

async function assertInstalledPackageMetadata(installDir) {
  const packageJsonPath = path.join(installDir, "node_modules", "proton-calendar-cli", "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.bin?.pc !== "src/cli.js") {
    throw new Error("Installed package does not expose the expected pc binary target");
  }
  if (typeof packageJson.engines?.node !== "string" || !packageJson.engines.node.includes(">=24")) {
    throw new Error("Installed package does not enforce the supported Node engine range");
  }
}

function execFileCrossPlatform(file, args, options = {}) {
  return execFileAsync(commandName(file), args, {
    ...options,
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function execPackageBin(installDir, args) {
  return execFileCrossPlatform("npm", ["exec", "--", "pc", ...args], { cwd: installDir });
}

function commandName(file) {
  if (process.platform !== "win32" || path.isAbsolute(file) || file.endsWith(".cmd")) {
    return file;
  }
  return `${file}.cmd`;
}
