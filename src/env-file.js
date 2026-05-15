import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSafeSecretFileSync } from "./secret-file-safety.js";

export function loadDotEnv(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd();
  const envPath = path.resolve(cwd, options.filename || ".env");
  let content;
  applyEnvAliases(env);

  try {
    assertSafeSecretFileSync(envPath, { required: false });
    content = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { loaded: false, path: envPath };
    }
    throw error;
  }

  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  applyEnvAliases(env);

  return { loaded: true, path: envPath };
}

export function applyEnvAliases(env = process.env) {
  applyEnvAlias(env, "PROTONMAIL_USERNAME", "PROTON_USERNAME");
  applyEnvAlias(env, "PROTONMAIL_PASSWORD", "PROTON_PASSWORD");
  applyEnvAlias(env, "PROTONMAIL_USERNAME2", "PROTON_USERNAME2");
  applyEnvAlias(env, "PROTONMAIL_PASSWORD2", "PROTON_PASSWORD2");
  return env;
}

export function parseDotEnv(content) {
  const values = {};
  const lines = String(content).replace(/^\uFEFF/, "").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(assignment);
    if (!match) {
      continue;
    }

    values[match[1]] = parseDotEnvValue(match[2]);
  }

  return values;
}

function parseDotEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\([nrt"\\])/g, (_match, escapeCode) => {
      const escapes = {
        n: "\n",
        r: "\r",
        t: "\t",
        '"': '"',
        "\\": "\\",
      };
      return escapes[escapeCode];
    });
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}

function applyEnvAlias(env, source, target) {
  if (env[target] === undefined && env[source] !== undefined) {
    env[target] = env[source];
  }
}
