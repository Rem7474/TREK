/** A single binary file (e.g. a PDF) sent natively to a multimodal provider. */
export interface LlmExtractionFile {
  mimeType: string;
  data: Buffer;
}

/** Everything a provider client needs to extract structured records from one document. */
export interface LlmExtractionInput {
  /** System instructions enumerating the schema.org shape (see llm-prompt.ts). */
  prompt: string;
  /** JSON Schema describing `{ <rootKey>: T[] }` (e.g. `{ reservations: KiReservation[] }`). */
  jsonSchema: object;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** Pre-extracted text (text-like files, or text-only-model mode). */
  text?: string;
  /** Native binary (PDF, or a receipt photo) for multimodal providers. */
  file?: LlmExtractionFile;
  /**
   * Root array key of the structured output — 'reservations' for the booking
   * import, 'receipts' for the receipt scanner. Clients read the array under
   * this key (and name the Anthropic tool after it). Defaults to 'reservations'.
   */
  rootKey?: string;
  /** User-turn instruction sent with the document. Defaults to the booking-import one. */
  userText?: string;
  /**
   * The endpoint is a self-hosted model server rather than a cloud provider.
   * Changes what the request may ask for: a grammar-constrained response is
   * affordable on hosted hardware and not on a CPU at home.
   */
  local?: boolean;
}

/**
 * A provider client turns one document into raw schema.org reservation objects.
 * It returns the parsed `reservations` array (best-effort: `[]` on a malformed or
 * empty response, never throwing for content reasons). The caller validates and
 * maps via the shared kitinerary mapper.
 */
export interface LlmExtractionClient {
  extract(input: LlmExtractionInput): Promise<Record<string, unknown>[]>;
}
