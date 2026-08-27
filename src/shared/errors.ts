export const ERROR_CODES = [
  "SOURCE_NOT_FOUND",
  "RECORD_NOT_FOUND",
  "RUN_NOT_FOUND",
  "MATCH_NOT_FOUND",
  "EXCEPTION_NOT_FOUND",
  "EXCEPTION_ALREADY_RESOLVED",
  "INGEST_TOO_LARGE",
  "INGEST_MALFORMED",
  "INGEST_UNSUPPORTED_TYPE",
  "ADJUDICATOR_UNAVAILABLE",
  "ADJUDICATOR_TIMEOUT",
  "ADJUDICATOR_MALFORMED_OUTPUT",
  "EVALUATION_NO_GROUND_TRUTH",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Partial<Record<ErrorCode, number>> = {
  SOURCE_NOT_FOUND: 404,
  RECORD_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  MATCH_NOT_FOUND: 404,
  EXCEPTION_NOT_FOUND: 404,
  EXCEPTION_ALREADY_RESOLVED: 409,
  INGEST_TOO_LARGE: 413,
  INGEST_MALFORMED: 400,
  INGEST_UNSUPPORTED_TYPE: 415,
  ADJUDICATOR_UNAVAILABLE: 503,
  ADJUDICATOR_TIMEOUT: 504,
  ADJUDICATOR_MALFORMED_OUTPUT: 502,
  EVALUATION_NO_GROUND_TRUTH: 409,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.status = STATUS[code] ?? 500;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL", error instanceof Error ? error.message : "Unexpected failure.");
}
