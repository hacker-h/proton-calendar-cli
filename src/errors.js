export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(error) {
  return error instanceof ApiError;
}

export function toErrorPayload(error) {
  if (isApiError(error)) {
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
      message: "Internal server error",
    },
  };
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

function sanitizeUpstreamPayload(payload) {
  if (payload && typeof payload === "object" && typeof payload.Code === "number") {
    return { code: payload.Code };
  }
  return {};
}
