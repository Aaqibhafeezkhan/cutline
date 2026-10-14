export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_OPERATION'
  | 'OVERLAP'
  | 'OUT_OF_RANGE'
  | 'LOCKED'
  | 'IN_USE'
  | 'NOTHING_TO_UNDO'
  | 'NOTHING_TO_REDO'
  | 'FORBIDDEN'
  | 'STALE'
  | 'UNSUPPORTED_VERSION'
  | 'INVARIANT';

export interface CutlineErrorJSON {
  code: ErrorCode;
  message: string;
  hint?: string;
  details?: unknown;
}

/**
 * Error with a machine-readable code and an actionable hint. Messages are
 * written for LLMs as much as for humans: say what is wrong and what to do.
 */
export class CutlineError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'CutlineError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): CutlineErrorJSON {
    const json: CutlineErrorJSON = { code: this.code, message: this.message };
    if (this.hint !== undefined) json.hint = this.hint;
    if (this.details !== undefined) json.details = this.details;
    return json;
  }

  /** "message Hint: hint" */
  describe(): string {
    return this.hint ? `${this.message} Hint: ${this.hint}` : this.message;
  }
}

export function isCutlineError(e: unknown): e is CutlineError {
  return e instanceof CutlineError;
}
