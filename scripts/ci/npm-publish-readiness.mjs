import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const releaseConfigPath = path.join(repoRoot, ".releaserc.json");
const releaseConfig = JSON.parse(await readFile(releaseConfigPath, "utf8"));
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pc-npm-publish-readiness-"));

try {
  await assertPackageMetadata();
  await assertReleaseVersionSource();
  await assertNoProjectNpmCredentials();

  const env = await createNoCredentialNpmEnv();
  const pack = await runNpmJson(["pack", "--dry-run", "--json", "--ignore-scripts"], env);
  assertPackDryRun(pack);

  const publish = await runNpmJson(["publish", "--dry-run", "--json", "--ignore-scripts", "--access", "public"], env, {
    allowMissingCredentials: true,
  });
  if (publish) {
    assertPublishDryRun(publish);
  }

  console.log("npm publish readiness passed without npm credentials or real publishing");
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

async function assertPackageMetadata() {
  assertEqual(packageJson.name, "proton-calendar-cli", "package name must match the reserved npm package name");
  assertMatches(packageJson.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "package version must be semver-like");
  assertEqual(packageJson.license, "MIT", "package license must be MIT");
  assertEqual(packageJson.type, "module", "package must remain ESM");
  if (packageJson.private === true) {
    throw new Error("package must not be marked private when checking publish readiness");
  }
  assertNonEmptyString(packageJson.description, "package description is required for npm metadata");
  assertNonEmptyString(packageJson.homepage, "package homepage is required for npm metadata");
  assertNonEmptyString(packageJson.repository?.url, "package repository.url is required for npm metadata");
  assertNonEmptyString(packageJson.bugs?.url, "package bugs.url is required for npm metadata");
  assertEqual(packageJson.bin?.pc, "src/cli.js", "pc bin target must point at src/cli.js");
  assertEqual(packageJson.engines?.node, ">=24", "Node engine must remain explicit for package consumers");

  assertExactArray(
    packageJson.files,
    ["src/", "scripts/bootstrap-proton-cookies.mjs", "README.md", "CHANGELOG.md", "LICENSE"],
    "package files list changed; keep published contents intentional",
  );

  for (const requiredPath of ["README.md", "LICENSE", "CHANGELOG.md", "src/cli.js", "scripts/bootstrap-proton-cookies.mjs"]) {
    await access(path.join(repoRoot, requiredPath));
  }

  const cli = await readFile(path.join(repoRoot, "src/cli.js"), "utf8");
  if (!cli.startsWith("#!/usr/bin/env node")) {
    throw new Error("src/cli.js must start with a node shebang for the npm bin");
  }

  if (process.platform !== "win32") {
    const cliStat = await stat(path.join(repoRoot, "src/cli.js"));
    if ((cliStat.mode & 0o111) === 0) {
      throw new Error("src/cli.js must be executable for the npm bin");
    }
  }
}

async function assertReleaseVersionSource() {
  assertExactArray(releaseConfig.branches, ["main"], "semantic-release branch source changed");
  assertEqual(releaseConfig.tagFormat, "v${version}", "semantic-release tag version source changed");

  const pluginNames = (releaseConfig.plugins || []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
  if (pluginNames.includes("@semantic-release/npm")) {
    throw new Error("@semantic-release/npm is enabled; update readiness checks before real npm publishing");
  }

  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  for (const requiredText of ["npm publishing is not enabled", "@semantic-release/npm", "trusted publishing"]) {
    if (!readme.includes(requiredText)) {
      throw new Error(`README must document npm version-source/publishing policy: missing ${requiredText}`);
    }
  }
}

async function assertNoProjectNpmCredentials() {
  const npmrcPath = path.join(repoRoot, ".npmrc");
  let npmrc;
  try {
    npmrc = await readFile(npmrcPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (/(^|\n)\s*(?:\/\/.*:)?(?:_(?:authToken|auth|password)|username|password)\s*=|NODE_AUTH_TOKEN|NPM_TOKEN/i.test(npmrc)) {
    throw new Error("Project .npmrc must not contain npm publish credentials");
  }
}

async function createNoCredentialNpmEnv() {
  const userNpmrcPath = path.join(tmpDir, "no-credentials-user.npmrc");
  const globalNpmrcPath = path.join(tmpDir, "no-credentials-global.npmrc");
  await writeFile(userNpmrcPath, "registry=https://registry.npmjs.org/\nprovenance=false\n", "utf8");
  await writeFile(globalNpmrcPath, "registry=https://registry.npmjs.org/\nprovenance=false\n", "utf8");

  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: userNpmrcPath,
    npm_config_userconfig: userNpmrcPath,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrcPath,
    npm_config_globalconfig: globalNpmrcPath,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    npm_config_registry: "https://registry.npmjs.org/",
    NPM_CONFIG_PROVENANCE: "false",
    npm_config_provenance: "false",
  };

  for (const key of Object.keys(env)) {
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key) || /^npm_config_(?:_|.*auth|.*token|username|password|_password)/i.test(key)) {
      delete env[key];
    }
  }

  return env;
}

async function runNpmJson(args, env, options = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(commandName("npm"), args, {
      cwd: repoRoot,
      env,
      maxBuffer: 1024 * 1024 * 10,
      shell: process.platform === "win32",
      windowsHide: true,
    }));
  } catch (error) {
    if (options.allowMissingCredentials && isMissingNpmCredentialsError(error)) {
      return null;
    }
    throw error;
  }
  return JSON.parse(stdout);
}

function isMissingNpmCredentialsError(error) {
  const stderr = String(error?.stderr || "");
  return stderr.includes("requires you to be logged in") || stderr.includes("ENEEDAUTH");
}

function commandName(file) {
  if (process.platform !== "win32" || path.isAbsolute(file) || file.endsWith(".cmd")) {
    return file;
  }
  return `${file}.cmd`;
}

function assertPackDryRun(result) {
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error("npm pack --dry-run must report exactly one package");
  }
  assertDryRunPackage(result[0]);
}

function assertPublishDryRun(result) {
  assertDryRunPackage(result);
}

function assertDryRunPackage(result) {
  assertEqual(result.name, packageJson.name, "dry-run package name mismatch");
  assertEqual(result.version, packageJson.version, "dry-run package version mismatch");
  assertMatches(result.filename, /^proton-calendar-cli-.*\.tgz$/, "dry-run tarball filename mismatch");
  if (!Number.isInteger(result.entryCount) || result.entryCount < 1) {
    throw new Error("dry-run package must report packaged entries");
  }

  const files = new Set((result.files || []).map((file) => file.path));
  for (const requiredPath of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "src/cli.js", "scripts/bootstrap-proton-cookies.mjs"]) {
    if (!files.has(requiredPath)) {
      throw new Error(`dry-run package is missing required file: ${requiredPath}`);
    }
  }

  for (const filePath of files) {
    if (!isAllowedPackagePath(filePath)) {
      throw new Error(`dry-run package includes unexpected file: ${filePath}`);
    }
    if (/(^|\/)(?:secrets|node_modules|reports|\.tmp|\.sisyphus|\.claude|\.playwright|\.pnpm-store)(?:\/|$)/.test(filePath)) {
      throw new Error(`dry-run package includes forbidden path: ${filePath}`);
    }
    if (/(^|\/)(?:\.env|\.npmrc)$/.test(filePath)) {
      throw new Error(`dry-run package includes a credential-bearing file: ${filePath}`);
    }
  }
}

function isAllowedPackagePath(filePath) {
  return (
    ["CHANGELOG.md", "LICENSE", "README.md", "package.json", "scripts/bootstrap-proton-cookies.mjs"].includes(filePath) ||
    filePath.startsWith("src/")
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatches(actual, pattern, message) {
  if (typeof actual !== "string" || !pattern.test(actual)) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}`);
  }
}

function assertNonEmptyString(actual, message) {
  if (typeof actual !== "string" || actual.trim() === "") {
    throw new Error(message);
  }
}

function assertExactArray(actual, expected, message) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
