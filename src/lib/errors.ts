export type ErrorCode = 'forbidden' | 'not_found' | 'conflict' | 'scope_required' | 'invalid' | 'unauthenticated' | 'rate_limited' | 'internal';

const STATUS: Record<ErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  scope_required: 403,
  invalid: 400,
  unauthenticated: 401,
  rate_limited: 429,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return STATUS[this.code];
  }
  toJSON(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const notFound = (what = 'Not found'): AppError => new AppError('not_found', what);
export const forbidden = (what = 'Forbidden'): AppError => new AppError('forbidden', what);
export const invalid = (what: string, details?: Record<string, unknown>): AppError => new AppError('invalid', what, details);
export const conflict = (what: string, details?: Record<string, unknown>): AppError => new AppError('conflict', what, details);
