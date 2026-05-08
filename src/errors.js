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
        details: error.details,
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
