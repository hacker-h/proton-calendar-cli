// @ts-check

/** @typedef {import("./contracts.js").ApiErrorPayload} ApiErrorPayload */
/** @typedef {import("./contracts.js").JsonValue} JsonValue */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {JsonValue | undefined} [details]
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {unknown} error
 * @returns {error is ApiError}
 */
export function isApiError(error) {
  return error instanceof ApiError;
}

/**
 * @param {unknown} error
 * @param {{ requestId?: string }} [options]
 * @returns {ApiErrorPayload}
 */
export function toErrorPayload(error, options = {}) {
  if (isApiError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        requestId: options.requestId,
        details: sanitizeErrorDetails(error.details),
      },
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
      requestId: options.requestId,
    },
  };
}

/**
 * @param {JsonValue | undefined} details
 * @returns {JsonValue | undefined}
 */
function sanitizeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return details;
  }

  if (!Object.hasOwn(details, "payload")) {
    return details;
  }

  const { payload, ...rest } = /** @type {{ payload?: unknown, [key: string]: unknown }} */ (details);
  return {
    ...rest,
    ...sanitizeUpstreamPayload(payload),
  };
}

/**
 * @param {unknown} payload
 * @returns {{ code?: number }}
 */
function sanitizeUpstreamPayload(payload) {
  const candidate = /** @type {{ Code?: unknown } | null} */ (payload && typeof payload === "object" ? payload : null);
  if (typeof candidate?.Code === "number") {
    return { code: candidate.Code };
  }
  return {};
}
