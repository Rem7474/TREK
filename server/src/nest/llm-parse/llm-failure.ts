/**
 * What the user is told when a provider call fails.
 *
 * The raw rejection is the provider's own JSON — nested, escaped, and written for
 * whoever wrote the endpoint. Putting it on a trip screen tells the person who
 * photographed a receipt nothing they can act on, and leaks endpoint internals
 * into the UI. `console.error` already records it verbatim at every call site, so
 * that is where it stays: the log keeps the evidence, the UI gets the cause in
 * words, and an unrecognised failure says plainly that the log has the detail
 * rather than pasting it.
 */

/** A photo sent to a text-only model. Never succeeds on retry — name the setting. */
const NO_VISION_SUPPORT = /multimodal|image_url|does not support (image|vision)|vision (is )?not supported|invalid[_ ]image/i;

/** The prompt outgrew the context window the server was started with. */
const CONTEXT_TOO_SMALL = /exceed_context_size|exceeds the available context|context (window|size|length) (is )?(too small|exceeded)|maximum context length/i;

/** Key missing, wrong, or lacking access to the model. */
const AUTH_REJECTED = /\b401\b|\b403\b|unauthorized|forbidden|invalid[_ ]api[_ ]key|incorrect api key|authentication/i;

/** Provider throttling — worth retrying later, unlike the rest. */
const RATE_LIMITED = /\b429\b|rate[_ ]limit|too many requests|quota|insufficient[_ ]quota/i;

/** The model never answered: cold start on CPU, or the server is down. */
const UNREACHABLE = /abort|timed? ?out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|\b50[234]\b/i;

/**
 * Stable identifier for the cause, so the client can say it in the reader's own
 * language. The English sentence beside it is the fallback and the log line —
 * a locale TREK does not ship must still get something usable.
 */
export type ProviderFailureCode =
  | 'noVision'
  | 'contextTooSmall'
  | 'authRejected'
  | 'rateLimited'
  | 'unreachable'
  | 'rejected';

export function classifyProviderFailure(err: unknown): ProviderFailureCode {
  const message = err instanceof Error ? err.message : String(err);
  if (NO_VISION_SUPPORT.test(message)) return 'noVision';
  if (CONTEXT_TOO_SMALL.test(message)) return 'contextTooSmall';
  if (AUTH_REJECTED.test(message)) return 'authRejected';
  if (RATE_LIMITED.test(message)) return 'rateLimited';
  if (UNREACHABLE.test(message)) return 'unreachable';
  return 'rejected';
}

/**
 * Turn a provider rejection into one actionable sentence. Falls back to pointing
 * at the log rather than quoting a body the reader cannot use.
 */
export function describeProviderFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (NO_VISION_SUPPORT.test(message)) {
    return 'the configured AI model cannot read images — choose a vision-capable model in the AI Parsing settings';
  }
  if (CONTEXT_TOO_SMALL.test(message)) {
    return "the document did not fit in the model's context window — raise it on the AI server (Ollama: OLLAMA_CONTEXT_LENGTH, 16384 or more for photos) or scan fewer pages at once";
  }
  if (AUTH_REJECTED.test(message)) {
    return 'the AI provider rejected the credentials — check the API key in the AI Parsing settings';
  }
  if (RATE_LIMITED.test(message)) {
    return 'the AI provider is rate-limiting this instance — try again in a moment';
  }
  if (UNREACHABLE.test(message)) {
    return 'the AI model did not answer in time — it may still be loading, or the server is unreachable';
  }
  return 'the AI provider rejected the request — the server log has its response';
}
