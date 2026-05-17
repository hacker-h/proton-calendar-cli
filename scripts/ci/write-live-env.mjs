#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cookieBundleRelativePath = "secrets/proton-cookies.json";
const cookieBundlePath = path.resolve(process.env.COOKIE_BUNDLE_PATH || cookieBundleRelativePath);
const cookieBundleEnvPath = formatCookieBundleEnvPath(cookieBundlePath);
const secondAccountCookieBundlePath = resolveSecondAccountCookieBundlePath(process.env);
const secondAccountCookieBundleEnvPath = secondAccountCookieBundlePath ? formatCookieBundleEnvPath(secondAccountCookieBundlePath) : null;
const outputPath = path.resolve(process.env.CI_LIVE_ENV_PATH || "secrets/ci-live.env");

const bundle = JSON.parse(await readFile(cookieBundlePath, "utf8"));
const discoveredCalendarIds = Array.isArray(bundle?.authProbe?.calendarIds)
  ? bundle.authProbe.calendarIds.map((value) => String(value || "").trim()).filter(Boolean)
  : [];
const discoveredDefaultCalendarId = String(bundle?.authProbe?.defaultCalendarId || "").trim();
const discoveredSecondaryCalendarId =
  discoveredCalendarIds.find((value) => value !== discoveredDefaultCalendarId) || discoveredDefaultCalendarId;
const requestedCalendarId = String(process.env.PROTON_TEST_CALENDAR_ID || process.env.TARGET_CALENDAR_ID || "").trim();
const configuredCalendarId = resolveConfiguredCalendarId({
  requestedCalendarId,
  discoveredCalendarIds,
  fallbackCalendarId: discoveredSecondaryCalendarId,
});
const allowedCalendarIds = [...new Set([configuredCalendarId, ...discoveredCalendarIds].filter(Boolean))];

if (!configuredCalendarId) {
  throw new Error("PROTON_TEST_CALENDAR_ID is required or bootstrap must discover defaultCalendarId");
}

const apiBearerToken = readApiBearerToken();
const protonBaseUrl = String(process.env.PROTON_BASE_URL || "https://calendar.proton.me").trim();
const apiBaseUrl = String(process.env.PC_API_BASE_URL || "http://127.0.0.1:8787").trim();

const lines = [
  `COOKIE_BUNDLE_PATH=${quote(cookieBundleEnvPath)}`,
  `TARGET_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `DEFAULT_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `ALLOWED_CALENDAR_IDS=${quote(allowedCalendarIds.join(","))}`,
  `PROTON_TEST_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `PROTON_DEFAULT_CALENDAR_ID=${quote(discoveredDefaultCalendarId)}`,
  `PROTON_SECONDARY_CALENDAR_ID=${quote(discoveredSecondaryCalendarId)}`,
  `API_BEARER_TOKEN=${quote(apiBearerToken)}`,
  `PC_API_TOKEN=${quote(apiBearerToken)}`,
  `PC_API_BASE_URL=${quote(apiBaseUrl)}`,
  `PROTON_BASE_URL=${quote(protonBaseUrl)}`,
  ...secondAccountEnvLines({ env: process.env, cookieBundlePath: secondAccountCookieBundleEnvPath }),
  "",
];

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, lines.join("\n"), { mode: 0o600 });

console.log(JSON.stringify({
  data: {
    outputPath,
    calendarId: configuredCalendarId,
    allowedCalendarIds,
    cookieBundlePath: cookieBundleEnvPath,
  },
}, null, 2));

function formatCookieBundleEnvPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function resolveConfiguredCalendarId({ requestedCalendarId, discoveredCalendarIds, fallbackCalendarId }) {
  if (!requestedCalendarId) {
    return fallbackCalendarId;
  }
  if (discoveredCalendarIds.length === 0 || discoveredCalendarIds.includes(requestedCalendarId)) {
    return requestedCalendarId;
  }
  return fallbackCalendarId;
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function readApiBearerToken() {
  const configured = String(process.env.API_BEARER_TOKEN || "").trim();
  return configured || randomBytes(32).toString("base64url");
}

function secondAccountEnvLines({ env, cookieBundlePath }) {
  if (!readBooleanFlag(env.PROTON_LIVE_ENABLE_SECOND_ACCOUNT) || !cookieBundlePath) {
    return [];
  }
  return [
    `PROTON_SECOND_ACCOUNT_COOKIE_BUNDLE_PATH=${quote(cookieBundlePath)}`,
    `PROTON_LIVE_ENABLE_SECOND_ACCOUNT=${quote("1")}`,
  ];
}

function resolveSecondAccountCookieBundlePath(env) {
  if (!readBooleanFlag(env.PROTON_LIVE_ENABLE_SECOND_ACCOUNT)) {
    return null;
  }
  return path.resolve(String(env.PROTON_SECOND_ACCOUNT_COOKIE_BUNDLE_PATH || "secrets/proton-cookies-second.json").trim() || "secrets/proton-cookies-second.json");
}

function readBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}
