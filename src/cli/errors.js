export class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
  }
}

const CLI_EXIT_CODES = Object.freeze({
  GENERAL_FAILURE: 1,
  VALIDATION_OR_USAGE: 2,
  AUTH_OR_SESSION: 3,
  LOCAL_API_UNAVAILABLE: 4,
  PROTON_UPSTREAM: 5,
  UNSUPPORTED_PRIVATE_API_STATE: 6,
});

const VALIDATION_ERROR_CODES = new Set([
  "CONFIG_ERROR",
  "EMPTY_PATCH",
  "INVALID_ARGS",
  "INVALID_REMINDERS",
  "INVALID_TIMEZONE",
  "SECRET_FILE_UNSAFE_PERMISSIONS",
  "UPDATE_CHECKSUM_MISMATCH",
  "UPDATE_UNSUPPORTED",
  "UNKNOWN_COMMAND",
]);

const AUTH_ERROR_CODES = new Set([
  "AUTH_EXPIRED",
  "AUTH_RELOGIN_REQUIRED",
  "LOGIN_FAILED",
  "UID_MISSING",
]);

const UPSTREAM_ERROR_CODES = new Set([
  "EVENT_LIST_PAGE_LIMIT",
  "PROTON_PERMISSION_DENIED",
  "PROTON_PLAN_REQUIRED",
  "RATE_LIMITED",
  "RECURRENCE_ITERATION_LIMIT",
  "UPSTREAM_ERROR",
  "UPSTREAM_EVENT_PAGE_LIMIT",
  "UPSTREAM_UNREACHABLE",
]);

const UNSUPPORTED_PRIVATE_API_ERROR_CODES = new Set([
  "AUTH_CHALLENGE_REQUIRED",
]);

export function toCliErrorPayload(error) {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: sanitizeErrorDetails(error.details),
      },
    };
  }
  if (error?.code === "SECRET_FILE_UNSAFE_PERMISSIONS") {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: sanitizeErrorDetails(error.details),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error?.message || "Internal error",
    },
  };
}

export function readCliExitCode(code) {
  if (VALIDATION_ERROR_CODES.has(code)) {
    return CLI_EXIT_CODES.VALIDATION_OR_USAGE;
  }
  if (AUTH_ERROR_CODES.has(code)) {
    return CLI_EXIT_CODES.AUTH_OR_SESSION;
  }
  if (code === "API_UNREACHABLE") {
    return CLI_EXIT_CODES.LOCAL_API_UNAVAILABLE;
  }
  if (UPSTREAM_ERROR_CODES.has(code)) {
    return CLI_EXIT_CODES.PROTON_UPSTREAM;
  }
  if (UNSUPPORTED_PRIVATE_API_ERROR_CODES.has(code)) {
    return CLI_EXIT_CODES.UNSUPPORTED_PRIVATE_API_STATE;
  }
  return CLI_EXIT_CODES.GENERAL_FAILURE;
}

export function sanitizeUpstreamPayload(payload) {
  const details = {};
  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    details.code = payload.Code;
  }
  return details;
}

function sanitizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return details;
  }

  if (!Object.hasOwn(details, "payload")) {
    return details;
  }

  const { payload, ...rest } = details;
  return {
    ...rest,
    ...sanitizeUpstreamPayload(payload),
  };
}
