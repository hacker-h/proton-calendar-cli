import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const supportedTargets = new Map([
  ["linux-x64", { platform: "linux", arch: "x64", file: "pc-linux-x64" }],
  ["macos-arm64", { platform: "darwin", arch: "arm64", file: "pc-macos-arm64" }],
  ["macos-x64", { platform: "darwin", arch: "x64", file: "pc-macos-x64" }],
  ["windows-x64", { platform: "win32", arch: "x64", file: "pc-windows-x64.exe" }],
]);

const seaNodePath = process.env.PC_SEA_NODE_PATH || process.execPath;
const target = process.env.PC_BINARY_TARGET || targetFromRuntime();
const targetConfig = supportedTargets.get(target);
if (!targetConfig) {
  throw new Error(`Unsupported PC_BINARY_TARGET ${target}. Supported targets: ${[...supportedTargets.keys()].join(", ")}`);
}
if (targetConfig.platform !== process.platform || targetConfig.arch !== process.arch) {
  throw new Error(`Target ${target} must be built on ${targetConfig.platform}/${targetConfig.arch}; current runner is ${process.platform}/${process.arch}`);
}

const outDir = path.join(repoRoot, "dist", "release");
const workDir = path.join(repoRoot, "dist", "standalone", target);
const entryPath = path.join(workDir, "sea-entry.mjs");
const bundlePath = path.join(workDir, "pc.cjs");
const seaConfigPath = path.join(workDir, "sea-config.json");
const seaBlobPath = path.join(workDir, "pc.blob");
const binaryPath = path.join(outDir, targetConfig.file);
const checksumPath = `${binaryPath}.sha256`;
const smokeDir = path.join(workDir, "smoke");

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(outDir, { recursive: true });
await mkdir(smokeDir, { recursive: true });

const cliImportPath = normalizeImportPath(path.relative(workDir, path.join(repoRoot, "src", "cli.js")));
await writeFile(entryPath, `import { runPcCli } from ${JSON.stringify(cliImportPath)};
runPcCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
`);

await build({
  entryPoints: [entryPath],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: {
    "import.meta.url": JSON.stringify(pathToFileURL(path.join(repoRoot, "src", "cli.js")).href),
  },
  logLevel: "silent",
});

await writeFile(seaConfigPath, `${JSON.stringify({
  main: bundlePath,
  output: seaBlobPath,
  disableExperimentalSEAWarning: true,
}, null, 2)}\n`);
await assertSeaCapableNode(seaNodePath);
await execFileAsync(seaNodePath, ["--experimental-sea-config", seaConfigPath], { cwd: repoRoot });

await copyFile(seaNodePath, binaryPath);
if (process.platform !== "win32") {
  await chmod(binaryPath, 0o755);
}
if (process.platform === "darwin") {
  await execFileAsync("codesign", ["--remove-signature", binaryPath]).catch(() => {});
}

const postjectArgs = ["exec", "postject", binaryPath, "NODE_SEA_BLOB", seaBlobPath, "--sentinel-fuse", seaFuse];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
await execFileAsync(commandName("pnpm"), postjectArgs, {
  cwd: repoRoot,
  maxBuffer: 1024 * 1024 * 10,
  shell: process.platform === "win32",
  windowsHide: true,
});

if (process.platform === "darwin") {
  await execFileAsync("codesign", ["--sign", "-", binaryPath]);
}

await smokeBinary(binaryPath, smokeDir);
await writeChecksum(binaryPath, checksumPath);
console.log(`Built ${path.relative(repoRoot, binaryPath)}`);
console.log(`Wrote ${path.relative(repoRoot, checksumPath)}`);

function targetFromRuntime() {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "macos-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "macos-x64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error(`No standalone binary target for ${process.platform}/${process.arch}`);
}

async function assertSeaCapableNode(file) {
  const data = await readFile(file);
  if (!data.includes(seaFuse)) {
    throw new Error(`Node binary ${file} does not contain the SEA fuse. Use an official Node 24 binary or set PC_SEA_NODE_PATH.`);
  }
}

async function smokeBinary(file, cwd) {
  const smokeEnv = withoutCliConfigEnv();
  const help = await execFileAsync(file, ["--help"], { cwd, env: smokeEnv, windowsHide: true, maxBuffer: 1024 * 1024 * 5 });
  if (!help.stdout.includes("pc - Proton Calendar CLI")) {
    throw new Error("Standalone pc binary did not print expected help text");
  }

  let configFailure = null;
  try {
    await execFileAsync(file, ["ls"], { cwd, env: smokeEnv, windowsHide: true, maxBuffer: 1024 * 1024 * 5 });
  } catch (error) {
    configFailure = error;
  }
  if (!configFailure) {
    throw new Error("Standalone pc ls unexpectedly succeeded without CLI config");
  }
  if (configFailure.code !== 2 || !String(configFailure.stderr || "").includes('"code": "CONFIG_ERROR"')) {
    throw new Error(`Standalone pc ls did not emit expected config error: ${configFailure.stderr || configFailure.message}`);
  }

  const missingChromePath = path.join(cwd, "missing-chrome");
  let loginFailure = null;
  try {
    await execFileAsync(file, ["login", "--chrome-path", missingChromePath, "--timeout", "1"], {
      cwd,
      env: smokeEnv,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 5,
    });
  } catch (error) {
    loginFailure = error;
  }
  if (!loginFailure) {
    throw new Error("Standalone pc login unexpectedly succeeded with a missing Chrome executable");
  }
  if (loginFailure.code !== 3 || !String(loginFailure.stderr || "").includes('"code": "LOGIN_FAILED"')) {
    throw new Error(`Standalone pc login did not exercise bundled bootstrap error handling: ${loginFailure.stderr || loginFailure.message}`);
  }
}

function withoutCliConfigEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PC_|API_BEARER_TOKEN|COOKIE_BUNDLE_PATH|PROTON)/.test(key)) {
      delete env[key];
    }
  }
  return env;
}

async function writeChecksum(file, checksumFile) {
  const data = await readFile(file);
  const hash = createHash("sha256").update(data).digest("hex");
  await writeFile(checksumFile, `${hash}  ${path.basename(file)}\n`);
  await access(checksumFile);
}

function commandName(file) {
  if (process.platform !== "win32" || path.isAbsolute(file) || file.endsWith(".cmd")) {
    return file;
  }
  return `${file}.cmd`;
}

function normalizeImportPath(value) {
  const normalized = value.split(path.sep).join("/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
