import { readFile } from "node:fs/promises";
import { DEFAULT_API_BASE_URL, DEFAULT_LOCAL_CONFIG_PATH } from "./constants.js";
import { CliError } from "./errors.js";
import { assertSafeSecretFile } from "../secret-file-safety.js";

export function readBaseUrl(env, localConfig) {
  const raw =
    env.PC_API_BASE_URL ||
    env.API_BASE_URL ||
    (localConfig && typeof localConfig.apiBaseUrl === "string" ? localConfig.apiBaseUrl : "") ||
    DEFAULT_API_BASE_URL;
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new CliError("CONFIG_ERROR", `Invalid PC_API_BASE_URL: ${raw}`);
  }
}

export function readToken(env, localConfig) {
  const token =
    env.PC_API_TOKEN ||
    env.API_BEARER_TOKEN ||
    (localConfig && typeof localConfig.apiToken === "string" ? localConfig.apiToken : "");
  if (!token || String(token).trim() === "") {
    throw new CliError(
      "CONFIG_ERROR",
      `Set PC_API_TOKEN/API_BEARER_TOKEN or add apiToken to ${env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH}`
    );
  }
  return String(token).trim();
}

export async function readLocalConfig(env) {
  const configPath = env.PC_CONFIG_PATH || DEFAULT_LOCAL_CONFIG_PATH;

  try {
    const fileStat = await assertSafeSecretFile(configPath, {
      required: false,
      createError: (message, details) => new CliError("SECRET_FILE_UNSAFE_PERMISSIONS", message, details),
    });
    if (!fileStat) {
      return null;
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError("CONFIG_ERROR", `Unable to read local config file: ${configPath}`);
  }

  let content;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw new CliError("CONFIG_ERROR", `Unable to read local config file: ${configPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CliError("CONFIG_ERROR", `Local config is not valid JSON: ${configPath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("CONFIG_ERROR", `Local config must be a JSON object: ${configPath}`);
  }

  return parsed;
}
