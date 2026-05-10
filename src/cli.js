#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELP_TEXT } from "./cli/constants.js";
import { readBaseUrl, readLocalConfig, readToken } from "./cli/config.js";
import { CliError, readCliExitCode, toCliErrorPayload } from "./cli/errors.js";
import { write, writeOutput } from "./cli/output.js";
import { runListCommand } from "./cli/commands/list-command.js";
import { runCreateCommand, runDeleteCommand, runEditCommand } from "./cli/commands/mutation-command.js";
import { runCalendarsCommand } from "./cli/commands/calendars-command.js";
import { runDoctorCommand } from "./cli/commands/doctor-command.js";
import { runLoginCommand } from "./cli/commands/login-command.js";
import { runLogoutCommand } from "./cli/commands/logout-command.js";

export async function runPcCli(argv, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || (() => Date.now());
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  try {
    const normalizedArgs = Array.isArray(argv) ? [...argv] : [];
    while (normalizedArgs[0] === "--") {
      normalizedArgs.shift();
    }

    const [rawCommand, ...rest] = normalizedArgs;
    const command = rawCommand || "help";

    if (["help", "--help", "-h"].includes(command)) {
      write(stdout, HELP_TEXT);
      return 0;
    }

    if (command === "login" || command === "authorize") {
      const result = await runLoginCommand(rest, {
        env,
        fetchImpl,
        stdout,
        bootstrapRunner: options.bootstrapRunner,
        generateToken: options.generateToken,
      });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (command === "logout") {
      const result = await runLogoutCommand(rest, { env });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (command === "doctor") {
      const result = await runDoctorCommand(rest, {
        env,
        fetchImpl,
      });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    const apiCommand = normalizeApiCommand(command);
    if (!apiCommand) {
      throw new CliError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
    }

    const localConfig = await readLocalConfig(env);
    const apiBaseUrl = readBaseUrl(env, localConfig);
    const apiToken = readToken(env, localConfig);

    if (apiCommand === "list") {
      const result = await runListCommand(rest, { apiBaseUrl, apiToken, fetchImpl, now });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "calendars") {
      const result = await runCalendarsCommand(rest, { env, apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "create") {
      const result = await runCreateCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "edit") {
      const result = await runEditCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }

    if (apiCommand === "delete") {
      const result = await runDeleteCommand(rest, { apiBaseUrl, apiToken, fetchImpl });
      writeOutput(stdout, result.output, result.payload);
      return 0;
    }
  } catch (error) {
    const payload = toCliErrorPayload(error);
    write(stderr, `${JSON.stringify(payload, null, 2)}\n`);
    return readCliExitCode(payload.error?.code);
  }
}

function normalizeApiCommand(command) {
  if (command === "ls" || command === "list") {
    return "list";
  }
  if (command === "new" || command === "create") {
    return "create";
  }
  if (command === "edit") {
    return "edit";
  }
  if (command === "rm" || command === "delete") {
    return "delete";
  }
  if (command === "calendars") {
    return "calendars";
  }
  return null;
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isEntrypoint) {
  runPcCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
