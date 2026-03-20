#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cookieBundlePath = path.resolve(process.env.COOKIE_BUNDLE_PATH || "secrets/proton-cookies.json");
const outputPath = path.resolve(process.env.CI_LIVE_ENV_PATH || "secrets/ci-live.env");

const bundle = JSON.parse(await readFile(cookieBundlePath, "utf8"));
const discoveredCalendarIds = Array.isArray(bundle?.authProbe?.calendarIds)
  ? bundle.authProbe.calendarIds.map((value) => String(value || "").trim()).filter(Boolean)
  : [];
const discoveredDefaultCalendarId = String(bundle?.authProbe?.defaultCalendarId || "").trim();
const discoveredSecondaryCalendarId =
  discoveredCalendarIds.find((value) => value !== discoveredDefaultCalendarId) || discoveredDefaultCalendarId;
const configuredCalendarId = String(
  process.env.PROTON_TEST_CALENDAR_ID || process.env.TARGET_CALENDAR_ID || discoveredSecondaryCalendarId
).trim();
const allowedCalendarIds = [...new Set([configuredCalendarId, ...discoveredCalendarIds].filter(Boolean))];

if (!configuredCalendarId) {
  throw new Error("PROTON_TEST_CALENDAR_ID is required or bootstrap must discover defaultCalendarId");
}

const apiBearerToken = String(process.env.API_BEARER_TOKEN || "gitlab-live-token").trim();
const protonBaseUrl = String(process.env.PROTON_BASE_URL || "https://calendar.proton.me").trim();

const lines = [
  `COOKIE_BUNDLE_PATH=${quote(cookieBundlePath)}`,
  `TARGET_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `DEFAULT_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `ALLOWED_CALENDAR_IDS=${quote(allowedCalendarIds.join(","))}`,
  `PROTON_TEST_CALENDAR_ID=${quote(configuredCalendarId)}`,
  `PROTON_DEFAULT_CALENDAR_ID=${quote(discoveredDefaultCalendarId)}`,
  `PROTON_SECONDARY_CALENDAR_ID=${quote(discoveredSecondaryCalendarId)}`,
  `API_BEARER_TOKEN=${quote(apiBearerToken)}`,
  `PC_API_TOKEN=${quote(apiBearerToken)}`,
  `PROTON_BASE_URL=${quote(protonBaseUrl)}`,
  "",
];

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, lines.join("\n"), { mode: 0o600 });

console.log(JSON.stringify({
  data: {
    outputPath,
    calendarId: configuredCalendarId,
    allowedCalendarIds,
    cookieBundlePath,
  },
}, null, 2));

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}
