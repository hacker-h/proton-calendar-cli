import { CliError } from "./errors.js";

export function validateStartBeforeEnd(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
    throw new CliError("INVALID_ARGS", "end must be after start");
  }
}
