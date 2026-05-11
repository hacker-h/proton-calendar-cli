import { ApiError } from "../../errors.js";

export function readInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function parseCursor(cursor) {
  const parsed = Number(cursor || "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function toUnix(isoString) {
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) {
    throw new ApiError(400, "INVALID_TIME_RANGE", "Invalid time range");
  }
  return Math.floor(ms / 1000);
}
