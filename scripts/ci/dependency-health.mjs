#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const errors = [];

const requiredNodeMajor = Number(String(packageJson.engines?.node || "").match(/>=\s*(\d+)/)?.[1] || 0);
const actualNodeMajor = Number(process.versions.node.split(".")[0]);
if (!requiredNodeMajor || actualNodeMajor < requiredNodeMajor) {
  errors.push(`Node ${process.versions.node} does not satisfy ${packageJson.engines?.node || "the configured engine"}`);
}

const [managerName, requiredPnpmVersion] = String(packageJson.packageManager || "").split("@");
if (managerName !== "pnpm" || !requiredPnpmVersion) {
  errors.push("packageManager must pin an exact pnpm version, for example pnpm@11.0.8");
} else {
  let actualPnpmVersion = "";
  try {
    actualPnpmVersion = execFileSync("pnpm", ["--version"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch (error) {
    errors.push(`Unable to run pnpm --version: ${error.message}`);
  }
  if (actualPnpmVersion && actualPnpmVersion !== requiredPnpmVersion) {
    errors.push(`pnpm ${actualPnpmVersion} does not match packageManager ${requiredPnpmVersion}`);
  }
}

for (const dependency of ["@steipete/sweet-cookie", "openpgp"]) {
  if (!packageJson.dependencies?.[dependency]) {
    errors.push(`Missing runtime dependency ${dependency}`);
  }
}

if (!packageJson.devDependencies?.playwright) {
  errors.push("Missing devDependency playwright for Proton login/browser smoke checks");
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`dependency-health: ${error}`);
  }
  process.exit(1);
}

console.log(`dependency-health: node ${process.versions.node}, pnpm ${requiredPnpmVersion}, dependency metadata ok`);
