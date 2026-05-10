import { CliError } from "./errors.js";

export function normalizeOutput(raw) {
  const value = String(raw || "json").trim().toLowerCase();
  if (!["json", "table"].includes(value)) {
    throw new CliError("INVALID_ARGS", `Unsupported output format: ${raw}`);
  }
  return value;
}

export function normalizeScope(raw) {
  const scope = String(raw || "").trim().toLowerCase();
  if (!["single", "following", "series"].includes(scope)) {
    throw new CliError("INVALID_ARGS", "--scope must be single, following, or series");
  }
  return scope;
}

export function requireValue(args, index, option) {
  const value = args[index];
  const trimmed = value === undefined || value === null ? "" : String(value).trim();
  if (trimmed === "") {
    throw new CliError("INVALID_ARGS", `${option} requires a value`);
  }
  return trimmed;
}
