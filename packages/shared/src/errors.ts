/**
 * Error taxonomy — the heart of "do NOT blindly retry".
 *
 * Every provider adapter normalises its native failure into one of these
 * classes, and the class alone decides what the router does next. Nothing
 * downstream inspects provider-specific error shapes.
 */

import type { ProviderAttempt } from './openai.js';

export const ErrorClass = {
  /** Request exceeded REQUEST_TIMEOUT_MS. Failover. */
  TIMEOUT: 'TIMEOUT',
  /** HTTP 429. Failover + cooldown honouring Retry-After. */
  RATE_LIMIT: 'RATE_LIMIT',
  /** 500/502/503/504 — upstream is broken but credentials are fine. Failover. */
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  /** Socket-level fault. Retry the SAME credential once, then failover. */
  NETWORK: 'NETWORK',
  /**
   * Upstream returned 401/403 — OUR provider key is bad. NEVER retry; disable
   * the credential. Surfaced to the client as 502: they did nothing wrong,
   * the gateway's own credential is broken.
   */
  AUTH: 'AUTH',
  /**
   * The CLIENT's router key is missing, invalid, revoked or disabled. Distinct
   * from AUTH so it maps to 401 instead of 502 — conflating the two either
   * tells a client to fix a key that is fine, or hides a broken provider
   * credential behind someone else's 401.
   */
  CLIENT_AUTH: 'CLIENT_AUTH',
  /** 404 / unknown model — NEVER retry; disable the model. */
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  /** The client's own payload is invalid. Abort; do not mask with failover. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Unparseable body or broken SSE frame. Failover. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** Context window exceeded. Failover only to a larger-context model. */
  CONTEXT_LENGTH: 'CONTEXT_LENGTH',
  /** Content filtered upstream. Terminal — another provider likely agrees. */
  CONTENT_FILTER: 'CONTENT_FILTER',
  /** Anything unrecognised. Treated conservatively as failover-able. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

/** What the routing engine should do when it sees a given error class. */
export const RetryAction = {
  /** Retry the same credential (bounded), then fall over. */
  RETRY_SAME: 'RETRY_SAME',
  /** Move to the next candidate immediately. */
  FAILOVER: 'FAILOVER',
  /** Stop the ladder and surface the error to the client. */
  TERMINAL: 'TERMINAL',
} as const;

export type RetryAction = (typeof RetryAction)[keyof typeof RetryAction];

/**
 * Single table mapping class → action. Kept as data rather than a switch so
 * the policy is inspectable, testable, and documentable in one glance.
 */
export const ERROR_POLICY: Record<
  ErrorClass,
  {
    action: RetryAction;
    /** Counts against the credential's health score. */
    countsAsFailure: boolean;
    /** Take the credential out of rotation entirely (until manual re-enable or probe). */
    disablesCredential: boolean;
    /** Take the model out of rotation. */
    disablesModel: boolean;
    /** HTTP status surfaced to the client if the whole ladder fails on this. */
    clientStatus: number;
  }
> = {
  TIMEOUT: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 504,
  },
  RATE_LIMIT: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 429,
  },
  PROVIDER_UNAVAILABLE: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 503,
  },
  NETWORK: {
    action: 'RETRY_SAME',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 502,
  },
  AUTH: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: true, // never retried on the request path
    disablesModel: false,
    clientStatus: 502,
  },
  CLIENT_AUTH: {
    // Never reaches the ladder — rejected at the edge, before routing.
    action: 'TERMINAL',
    countsAsFailure: false,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 401,
  },
  MODEL_UNAVAILABLE: {
    action: 'FAILOVER',
    countsAsFailure: false, // the credential is fine; the model is not
    disablesCredential: false,
    disablesModel: true,
    clientStatus: 502,
  },
  BAD_REQUEST: {
    action: 'TERMINAL',
    countsAsFailure: false,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 400,
  },
  MALFORMED_RESPONSE: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 502,
  },
  CONTEXT_LENGTH: {
    action: 'FAILOVER',
    countsAsFailure: false,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 400,
  },
  CONTENT_FILTER: {
    action: 'TERMINAL',
    countsAsFailure: false,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 400,
  },
  UNKNOWN: {
    action: 'FAILOVER',
    countsAsFailure: true,
    disablesCredential: false,
    disablesModel: false,
    clientStatus: 502,
  },
};

/**
 * Normalised error carried through the router. `RouterError` is the only
 * error type the routing engine reasons about.
 */
export class RouterError extends Error {
  readonly errorClass: ErrorClass;
  /** Upstream HTTP status, when the failure was an HTTP response. */
  readonly upstreamStatus?: number;
  /** Seconds from Retry-After, when the upstream supplied one. */
  readonly retryAfterSec?: number;
  /** Provider name that produced this failure. */
  readonly provider?: string;
  /** Safe, already-redacted upstream detail. Never contains credentials. */
  readonly detail?: string;
  /**
   * Attempts made before this error ended the ladder.
   *
   * Populated by the fallback executor when it aborts on a TERMINAL class, so a
   * terminal failure is as diagnosable as an exhausted one. Mutable because the
   * executor knows the trail only after constructing the error it is rethrowing.
   */
  attempts?: ProviderAttempt[];

  constructor(
    errorClass: ErrorClass,
    message: string,
    opts: {
      upstreamStatus?: number;
      retryAfterSec?: number;
      provider?: string;
      detail?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'RouterError';
    this.errorClass = errorClass;
    this.upstreamStatus = opts.upstreamStatus;
    this.retryAfterSec = opts.retryAfterSec;
    this.provider = opts.provider;
    this.detail = opts.detail;
  }

  get policy() {
    return ERROR_POLICY[this.errorClass];
  }

  /** OpenAI-shaped error body. */
  toClientJSON(codeOverride?: string) {
    return {
      error: {
        message: this.message,
        type: openAiErrorType(this.errorClass),
        code: codeOverride ?? this.errorClass.toLowerCase(),
        param: null,
      },
    };
  }
}

function openAiErrorType(c: ErrorClass): string {
  switch (c) {
    case 'AUTH':
    case 'CLIENT_AUTH':
      return 'authentication_error';
    case 'RATE_LIMIT':
      return 'rate_limit_error';
    case 'BAD_REQUEST':
    case 'CONTEXT_LENGTH':
      return 'invalid_request_error';
    case 'CONTENT_FILTER':
      return 'content_filter_error';
    default:
      return 'api_error';
  }
}

/** Router-level error codes surfaced to clients (stable, documented). */
export const RouterErrorCode = {
  INVALID_MODEL_FORMAT: 'invalid_model_format',
  ALL_PROVIDERS_UNAVAILABLE: 'all_providers_unavailable',
  NO_CANDIDATES: 'no_candidates_available',
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
} as const;
