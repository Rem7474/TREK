import type { KiReservation } from '../booking-import/kitinerary.types';
import { createLlmClient } from './llm-client.factory';
import { LlmConfigResolver } from './llm-config.resolver';
import { LlmLocalService } from './llm-local.service';
import { buildSystemPrompt, KI_RESERVATION_JSON_SCHEMA } from './llm-prompt';
import type { LlmExtractionInput } from './llm-provider.interface';
import { isPdf, imageMimeType, extractText } from './text-extract';
import { toRecordList } from './lenient-json';
import { classifyProviderFailure, describeProviderFailure, type ProviderFailureCode } from './llm-failure';
import { capReceiptImage } from './receipt-image';
import {
  buildQuickReceiptPrompt,
  buildReceiptPrompt,
  RECEIPT_JSON_SCHEMA,
  RECEIPT_ROOT_KEY,
  RECEIPT_USER_INSTRUCTION,
} from './receipt-prompt';
import { routeExtraction, detectFlightNumbers } from './router/extraction-router';
import { extractEnforced } from './router/ollama-format.client';
import { Injectable } from '@nestjs/common';
import { kiReservationSchema, modelReadsPhotos } from '@trek/shared';
import { RuntimeEnvService } from '../app-config/runtime-env.service';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
};

export interface LlmParseResult {
  kiItems: KiReservation[];
  warnings: string[];
}

/** Raw receipt objects straight from the model — the receipt mapper validates them. */
export interface LlmReceiptResult {
  receipts: Record<string, unknown>[];
  warnings: string[];
  /** Why the provider refused, when it did — the client translates this. */
  failureCode?: ProviderFailureCode;
}

/** Text fed to the model for a receipt — they are short, so the cap is tight. */
const MAX_RECEIPT_CHARS = 6000;

/**
 * Orchestrates the LLM fallback: resolve config → pick client → build input
 * (native bytes vs extracted text by the `multimodal` flag) → call provider →
 * validate the response → return schema.org `KiReservation[]` for the shared
 * mapper. Never throws for content/provider reasons — degrades to `[]` + a
 * warning, mirroring the kitinerary extractor's tolerance.
 */
@Injectable()
export class LlmParseService {
  constructor(
    private readonly llmConfig: LlmConfigResolver,
    private readonly llmLocal: LlmLocalService,
    private readonly env: RuntimeEnvService,
  ) {}

  /** True when the addon is enabled AND a usable config resolves for this user. */
  isAvailable(userId: number): boolean {
    return this.llmConfig.resolve(userId) !== null;
  }

  /**
   * Whether this user's model can be handed an image at all.
   *
   * A text-only model does not do its best with one, the provider rejects it —
   * after the minutes a read takes. So the answer decides whether the affordance
   * is offered in the first place. The operator's switch is taken at its word;
   * without it the catalogue answers for the models it knows, which keeps a
   * working setup working without anyone having to go and confirm it.
   */
  async readsPhotos(userId: number): Promise<boolean> {
    const config = this.llmConfig.resolve(userId);
    if (!config) return false;
    // The operator's switch is an explicit override and wins outright.
    if (config.multimodal) return true;
    // On a self-hosted server the answer is not a matter of opinion: Ollama
    // reports it. `null` means an older server with nothing to say, and the
    // guess below takes over rather than hiding a model that works.
    if (config.provider === 'local') {
      const caps = await this.llmLocal.capabilities(config.baseUrl, config.model);
      if (caps) return caps.includes('vision');
    }
    // Cloud providers have no equivalent endpoint — the id is all there is.
    return modelReadsPhotos(config.model);
  }

  async parse(file: { buffer: Buffer; originalName: string }, userId: number): Promise<LlmParseResult> {
    const config = this.llmConfig.resolve(userId);
    if (!config) return { kiItems: [], warnings: ['AI parsing is not configured'] };

    const warnings: string[] = [];
    const input: LlmExtractionInput = {
      prompt: buildSystemPrompt(),
      jsonSchema: KI_RESERVATION_JSON_SCHEMA,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      local: config.provider === 'local',
    };

    // Native PDF only for Anthropic (its document block reads text AND scans).
    // OpenAI-compatible servers (incl. Ollama/NuExtract) can't ingest PDFs/`file`
    // parts, so every other provider gets extracted text.
    try {
      if (config.provider === 'anthropic' && isPdf(file.originalName)) {
        input.file = { mimeType: MIME_BY_EXT['.pdf'], data: file.buffer };
        console.debug(
          `[DEBUG] Extracted (native PDF, ${file.buffer.length} bytes) sent to ${config.provider}: ${file.originalName}`,
        );
      } else {
        input.text = await extractText(file.buffer, file.originalName);
        // Cap the text fed to the model. A flight itinerary lists its legs throughout a long
        // document, so it keeps a generous window; a single booking has the essentials up top,
        // so cap it tighter to keep CPU prompt-eval fast (a 11-page rental voucher was ~200s at
        // 16k, the booking data sits in the first ~2k). Cloud single-shot keeps the tight cap.
        const MAX_EXTRACT_CHARS =
          config.provider !== 'local' ? 4000 : detectFlightNumbers(input.text).length > 0 ? 16000 : 6000;
        if (input.text.length > MAX_EXTRACT_CHARS) input.text = input.text.slice(0, MAX_EXTRACT_CHARS);
        // The extracted text IS the booking: traveller name, address, booking
        // reference. On a centrally administered install that would land in the
        // operator's log, which is a processing nobody asked for and nobody needs.
        if (this.env.isManaged()) {
          console.debug(`[DEBUG] Extracted text from ${file.originalName} (${input.text.length} chars)`);
        } else {
          console.debug(`[DEBUG] Extracted text from ${file.originalName} (${input.text.length} chars):\n`, input.text);
        }
        if (!input.text.trim()) {
          return {
            kiItems: [],
            warnings: [`${file.originalName}: no readable text found (a scanned PDF needs a cloud/vision provider)`],
          };
        }
      }
    } catch (err) {
      console.error(`[llm-parse] Could not read "${file.originalName}":`, err instanceof Error ? err.message : err);
      return {
        kiItems: [],
        warnings: [`${file.originalName}: could not read file — ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    // Local provider (Ollama): go through the layered extraction router — vendor
    // templates → decompose + grammar-enforced per-reservation extraction → validate
    // + repair. Far more reliable on small CPU models than the single-shot path below
    // (which stays for cloud providers, whose strong models handle one-shot well).
    if (config.provider === 'local' && input.text) {
      try {
        const routed = await routeExtraction(input.text, {
          baseUrl: config.baseUrl ?? 'http://localhost:11434/v1',
          model: config.model,
          apiKey: config.apiKey,
        });
        return { kiItems: routed.kiItems, warnings: [...warnings, ...routed.warnings] };
      } catch (err) {
        console.error(`[llm-parse] AI parsing failed for "${file.originalName}" (provider=${config.provider}):`, err instanceof Error ? err.message : err);
        return {
          kiItems: [],
          warnings: [`${file.originalName}: AI parsing failed — ${describeProviderFailure(err)}`],
        };
      }
    }

    let raw: Record<string, unknown>[];
    try {
      raw = await createLlmClient(config).extract(input);
      // Same reason: the model answers with the fields it read out of the document.
      if (this.env.isManaged()) console.debug(`[DEBUG] LLM response: ${raw.length} item(s)`);
      else console.debug('[DEBUG] Raw LLM Response: ', raw);
    } catch (err) {
      console.error(`[llm-parse] AI parsing failed for "${file.originalName}" (provider=${config.provider}):`, err instanceof Error ? err.message : err);
      return {
        kiItems: [],
        warnings: [`${file.originalName}: AI parsing failed — ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    const kiItems: KiReservation[] = [];
    for (const node of raw) {
      const result = kiReservationSchema.safeParse(node);
      if (result.success) kiItems.push(normalizeNode(result.data) as unknown as KiReservation);
      else warnings.push(`${file.originalName}: skipped an unrecognized AI result`);
    }

    return { kiItems, warnings };
  }

  /**
   * Extract receipts from one uploaded document. Same provider plumbing as
   * `parse()`, different prompt/schema — and one extra input mode: a photo is
   * sent as native image bytes, since a till roll has no text layer to extract.
   *
   *  - image (jpg/png/webp/heic/…) → bytes, straight to the vision model
   *  - PDF   → native document block on Anthropic, extracted text elsewhere
   *  - txt/html/eml → extracted text
   *
   * Never throws for content/provider reasons — degrades to `[]` + a warning,
   * mirroring the booking-import path.
   */
  async parseReceipt(
    file: { buffer: Buffer; originalName: string },
    userId: number,
    quick = false,
  ): Promise<LlmReceiptResult> {
    const config = this.llmConfig.resolve(userId);
    if (!config) return { receipts: [], warnings: ['AI parsing is not configured'] };

    const input: LlmExtractionInput = {
      prompt: quick ? buildQuickReceiptPrompt() : buildReceiptPrompt(),
      jsonSchema: RECEIPT_JSON_SCHEMA,
      rootKey: RECEIPT_ROOT_KEY,
      userText: RECEIPT_USER_INSTRUCTION,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      local: config.provider === 'local',
    };

    const imageMime = imageMimeType(file.originalName);
    try {
      if (imageMime) {
        // A photographed receipt only exists as pixels — the model has to see it,
        // but not all of them: a full-size phone photo reads worse than a capped
        // one, and slower. The browser caps it too; this is the copy nothing can
        // route around.
        input.file = await capReceiptImage(file.buffer, imageMime);
      } else if (config.provider === 'anthropic' && isPdf(file.originalName)) {
        input.file = { mimeType: MIME_BY_EXT['.pdf'], data: file.buffer };
      } else {
        input.text = await extractText(file.buffer, file.originalName);
        if (input.text.length > MAX_RECEIPT_CHARS) input.text = input.text.slice(0, MAX_RECEIPT_CHARS);
        if (!input.text.trim()) {
          return {
            receipts: [],
            warnings: [
              `${file.originalName}: no readable text found — photograph the receipt instead, or use a provider that reads scanned PDFs`,
            ],
          };
        }
      }
    } catch (err) {
      console.error(`[llm-parse] Could not read "${file.originalName}":`, err instanceof Error ? err.message : err);
      return {
        receipts: [],
        warnings: [`${file.originalName}: could not read file — ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    try {
      const raw =
        config.provider === 'local'
          ? await this.readReceiptLocally(input, imageMime !== null)
          : await createLlmClient(config).extract(input);
      return { receipts: raw, warnings: [] };
    } catch (err) {
      console.error(
        `[llm-parse] Receipt scan failed for "${file.originalName}" (provider=${config.provider}):`,
        err instanceof Error ? err.message : err,
      );
      return {
        receipts: [],
        failureCode: classifyProviderFailure(err),
        warnings: [`${file.originalName}: scan failed — ${describeProviderFailure(err)}`],
      };
    }
  }

  /**
   * Read a receipt on a self-hosted server, through Ollama's own chat API.
   *
   * The OpenAI-compatible endpoint cannot express what this needs. Measured
   * against qwen3.5:4b reading one receipt, same prompt, same server:
   *
   *   /v1                      485s — 4096 tokens of reasoning, empty answer
   *   /api/chat think:false     49s — the whole receipt, correctly
   *
   * It is not a speed difference, it is the difference between a scan that
   * works and one that does not. `think` is a real parameter here and an
   * ignored one on /v1 (measured), so a hybrid model — which is every model
   * TREK offers — spends the entire token budget reasoning and returns nothing.
   * `num_ctx` is the same story: on /v1 it cannot be asked for at all, which is
   * why the context-too-small failure tells the operator to go and change a
   * server-wide environment variable.
   *
   * Cloud providers keep the OpenAI-compatible client: they have no equivalent
   * endpoint, and neither problem.
   */
  private async readReceiptLocally(
    input: LlmExtractionInput,
    isPhoto: boolean,
  ): Promise<Record<string, unknown>[]> {
    const out = await extractEnforced({
      baseUrl: input.baseUrl ?? 'http://localhost:11434/v1',
      model: input.model,
      apiKey: input.apiKey,
      system: input.prompt,
      user: input.text ? `${input.userText ?? ''}\n\n${input.text}`.trim() : (input.userText ?? ''),
      images: input.file ? [input.file.data.toString('base64')] : undefined,
      // A photograph costs far more context than the text of the same receipt.
      numCtx: isPhoto ? 16384 : 8192,
      // Generous: a supermarket receipt is a long list of lines, and with
      // reasoning off nothing else competes for the budget.
      numPredict: 4096,
    });
    return toRecordList(out, RECEIPT_ROOT_KEY);
  }
}

/** Root-level keys in the schema.org reservation shape; everything else is trip-specific. */
const ROOT_KEYS = new Set([
  '@type',
  'reservationNumber',
  'checkinTime',
  'checkoutTime',
  'pickupTime',
  'dropoffTime',
  'startTime',
  'endTime',
  'pickupLocation',
  'dropoffLocation',
  'seat',
  'class',
  'platform',
  'price',
  'priceCurrency',
  'reservationFor',
]);

/**
 * Small models often flatten the type-specific fields (flightNumber, airline,
 * departureAirport, …) onto the reservation root instead of nesting them under
 * `reservationFor`, which is where the kitinerary mapper reads them. When
 * `reservationFor` is missing/empty, fold the non-root keys into it so the
 * existing mappers work unchanged.
 */
function normalizeNode(node: Record<string, unknown>): Record<string, unknown> {
  const rf = node.reservationFor;
  if (rf && typeof rf === 'object' && Object.keys(rf as object).length > 0) return node;

  const out: Record<string, unknown> = {};
  const reservationFor: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (ROOT_KEYS.has(k)) out[k] = v;
    else reservationFor[k] = v;
  }
  // Nothing to fold (no flattened type fields) — leave the node as-is.
  if (Object.keys(reservationFor).length === 0) return node;
  out.reservationFor = reservationFor;
  return out;
}
