/**
 * Typed provider errors. Messages are always secret-free (callers pass
 * already-redacted text; `ProviderError` never embeds request headers).
 *
 * Convention used by every adapter in this package:
 *  - THROW a ProviderError when nothing was spent / nothing happened
 *    (missing credentials, auth failure, validation, budget refusal,
 *    pre-flight provider errors).
 *  - RETURN a `status: "failed"` CreativeOutput when the provider accepted a
 *    paid job and later reported failure (so the ledger can record it).
 */
export type ProviderErrorCode =
  | "not_configured"
  | "auth"
  | "forbidden"
  | "insufficient_credits"
  | "rate_limited"
  | "concurrency_limit"
  | "validation"
  | "budget_exceeded"
  | "timeout"
  | "unavailable"
  | "bad_response"
  | "structured_output"
  | "not_found"
  | "unsupported"
  | "compliance"
  | "ambiguous_submission"
  | "generation_failed"
  | "provider_error";

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(["rate_limited", "concurrency_limit", "timeout", "unavailable"]);

export class ProviderError extends Error {
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  /** True when the same request may succeed later without changes. */
  readonly retryable: boolean;
  readonly meta?: Record<string, unknown>;

  constructor(provider: string, code: ProviderErrorCode, message: string, opts: { status?: number; retryable?: boolean; meta?: Record<string, unknown>; cause?: unknown } = {}) {
    super(`${provider}: ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.meta = opts.meta;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Map an HTTP status to the closest ProviderErrorCode. */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401) return "auth";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 409) return "validation";
  if (status === 400 || status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status === 503 || status === 502 || status === 423) return "unavailable";
  if (status >= 500) return "provider_error";
  return "provider_error";
}
