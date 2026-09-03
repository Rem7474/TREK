import JSON5 from 'json5';

/**
 * A hybrid model's reasoning, and the opening tag of a thought it never closed.
 *
 * Qwen3/Qwen3.5 and the other hybrid models emit `<think>…</think>` before the
 * answer unless thinking is turned off, and the OpenAI-compatible endpoint has
 * no field that turns it off on every server that speaks it. The request asks
 * (see the clients); this is what makes the answer readable when the ask was
 * ignored — without it a perfectly good extraction parses as nothing at all.
 */
const REASONING_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
const UNCLOSED_REASONING = /^[\s\S]*?<\/(think|thinking|reasoning)>/i;

/** Fenced code block, with or without a language tag. */
function stripFences(content: string): string {
  return content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
}

function stripReasoning(content: string): string {
  const withoutBlocks = content.replace(REASONING_BLOCK, '');
  // A closing tag with no opener left means the opener was in a chunk we never
  // saw (or the model opened one and the fence swallowed it) — the answer is
  // whatever follows the close.
  return stripFences(/<\/(think|thinking|reasoning)>/i.test(withoutBlocks)
    ? withoutBlocks.replace(UNCLOSED_REASONING, '')
    : withoutBlocks);
}

/**
 * Parse LLM output that is *meant* to be JSON but may not be strict JSON.
 *
 * Cloud providers reached through the OpenAI-compatible endpoint don't all honour
 * `response_format` faithfully — Gemini in particular emits JavaScript-object-literal
 * text: single-quoted strings, unquoted keys, and trailing commas (#1638), e.g.
 *
 *   [ { '@type': 'LodgingReservation', checkinTime: '2026-08-28T00:00:00', price: 146.25, } ]
 *
 * Strict `JSON.parse` throws on all three, so the reservation list came back empty and
 * the UI showed nothing. We try strict JSON first (the common, cheapest path) and fall
 * back to JSON5, which accepts exactly that relaxed superset. Returns `null` on failure.
 *
 * The leading/trailing code-fence strip stays here because some models still wrap the
 * payload in a ```json fence even when asked for raw JSON, and a hybrid model's
 * reasoning block is stripped on a second pass (see REASONING_BLOCK above).
 */
export function parseLenientJson(content: string | undefined | null): unknown {
  if (!content) return null;
  const stripped = stripFences(content);
  // The reasoning strip is a SECOND attempt, never the first: a response that
  // already parses is returned untouched, so nothing that works today can be
  // changed by it.
  for (const candidate of [stripped, stripReasoning(stripped)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON5.parse(candidate);
      } catch {
        // try the next candidate
      }
    }
  }
  return null;
}

/**
 * Whatever a provider handed back, as a list of reservation nodes.
 *
 * The extraction tool declares `reservations` as an array and the call forces
 * that tool, so the answer should already be one. It is not always. Anthropic
 * sometimes serialises its tool input as a JSON-encoded string instead (#1968),
 * in either of two shapes seen in the wild:
 *
 *   "[{\"@type\":\"LodgingReservation\", …}]"      a stringified array
 *   "{\"reservations\":[{…}]}"                      stringified and re-wrapped
 *
 * Whether it happens is up to how the model serialises that particular call, so
 * the same document imported fine one minute and came back empty the next —
 * indistinguishable, to the person waiting, from a document with no booking in
 * it. Nothing was logged, because nothing had failed: the value simply was not
 * an array, and the check that only accepted arrays dropped a good extraction.
 *
 * One unwrap of a string, not a loop: a value that is still not a list after
 * that is genuinely not one, and guessing further would start inventing
 * bookings out of prose.
 */
export function toReservationList(value: unknown): Record<string, unknown>[] {
  const list = (v: unknown): Record<string, unknown>[] | null => {
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === 'object' && Array.isArray((v as { reservations?: unknown }).reservations)) {
      return (v as { reservations: Record<string, unknown>[] }).reservations;
    }
    return null;
  };

  const direct = list(value);
  if (direct) return direct;
  if (typeof value === 'string') return list(parseLenientJson(value)) ?? [];
  return [];
}
