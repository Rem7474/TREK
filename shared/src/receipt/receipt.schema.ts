import { expenseSplitModeSchema, type CostCategory } from '../budget/budget.schema';

import { z } from 'zod';

/**
 * Receipt scanning API contract — single source of truth for the
 * /api/trips/:tripId/receipts endpoints (scan → review → confirm).
 *
 * The flow mirrors the booking import (see reservation.schema.ts) but starts
 * from a *paid* document rather than a booking: the user photographs or uploads
 * a receipt/invoice, an LLM classifies it (meal, hotel, transport, …) and pulls
 * out the amount, and the confirm step creates the expense — plus, when the
 * document describes a stay or a journey, the matching reservation/place and
 * the receipt itself as a trip document.
 *
 * Trip-scoped: every endpoint verifies trip access (404 "Trip not found") and
 * checks the 'budget_edit' permission (403 "No permission"); creating a
 * reservation alongside additionally needs 'reservation_edit'. Mutations
 * broadcast over WebSocket with the forwarded X-Socket-Id.
 */

/**
 * What the scanned document is. This is the classification the model is asked
 * for — it drives both the expense category and whether a reservation is worth
 * creating alongside the expense (see the two maps below).
 */
export const RECEIPT_DOC_TYPES = [
  'meal',
  'groceries',
  'accommodation',
  'transport',
  'flight',
  'fuel',
  'activity',
  'shopping',
  'health',
  'fees',
  'other',
] as const;
export type ReceiptDocType = (typeof RECEIPT_DOC_TYPES)[number];

export const receiptDocTypeSchema = z.enum(RECEIPT_DOC_TYPES);

/** Detected document type → fixed Costs category (budget.schema.ts COST_CATEGORIES). */
const DOC_TYPE_TO_COST_CATEGORY: Record<ReceiptDocType, CostCategory> = {
  meal: 'food',
  groceries: 'groceries',
  accommodation: 'accommodation',
  transport: 'transport',
  flight: 'flights',
  fuel: 'transport',
  activity: 'activities',
  shopping: 'shopping',
  health: 'health',
  fees: 'fees',
  other: 'other',
};

export function receiptDocTypeToCostCategory(type: string | null | undefined): CostCategory {
  if (!type) return 'other';
  return DOC_TYPE_TO_COST_CATEGORY[type.trim().toLowerCase() as ReceiptDocType] ?? 'other';
}

/**
 * Detected document type → reservation `type`, for the doc types where the
 * receipt also documents something that belongs on the itinerary (a stay, a
 * journey). `null` means "expense only" — a lunch bill or a supermarket ticket
 * has nothing to put on the planner.
 *
 * A transport receipt maps to the catch-all 'transport_other' type; the mapper
 * narrows it to train/bus/taxi/car/ferry/transit when the document names the mode.
 */
const DOC_TYPE_TO_RESERVATION_TYPE: Record<ReceiptDocType, string | null> = {
  meal: 'restaurant',
  groceries: null,
  accommodation: 'hotel',
  transport: 'transport_other',
  flight: 'flight',
  fuel: null,
  activity: 'event',
  shopping: null,
  health: null,
  fees: null,
  other: null,
};

/**
 * Transport modes the planner draws — the same list its transport form offers.
 *
 * The model is asked which one a ticket is, because recognising the operator is
 * the part a regex loses: a carrier list can only ever name the operators
 * somebody thought of, and "Comboios de Portugal" or "Ferrocarrils de la
 * Generalitat" are railways whether or not they are on it. The pattern match
 * stays as the fallback for a model that leaves the field out.
 */
export const RECEIPT_TRANSPORT_MODES = [
  'flight',
  'train',
  'bus',
  'car',
  'taxi',
  'bicycle',
  'cruise',
  'ferry',
  'transit',
  'transport_other',
] as const;
export type ReceiptTransportMode = (typeof RECEIPT_TRANSPORT_MODES)[number];

const TRANSPORT_MODE_SET = new Set<string>(RECEIPT_TRANSPORT_MODES);

/** The model's transport mode when it named a real one, else null. */
export function normalizeTransportMode(value: unknown): ReceiptTransportMode | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return TRANSPORT_MODE_SET.has(raw) ? (raw as ReceiptTransportMode) : null;
}

export function receiptDocTypeToReservationType(type: string | null | undefined): string | null {
  if (!type) return null;
  return DOC_TYPE_TO_RESERVATION_TYPE[type.trim().toLowerCase() as ReceiptDocType] ?? null;
}

/**
 * Whether a reservation is created ALONGSIDE the expense by default for this
 * doc type. A hotel or a train ticket documents a real itinerary entry; a meal
 * or a museum ticket is usually just money already spent, so the toggle starts
 * off and the user can flip it in the review step.
 */
const DOC_TYPES_CREATING_RESERVATIONS = new Set<ReceiptDocType>(['accommodation', 'transport', 'flight']);

export function receiptCreatesReservationByDefault(type: string | null | undefined): boolean {
  return DOC_TYPES_CREATING_RESERVATIONS.has((type ?? '').trim().toLowerCase() as ReceiptDocType);
}

/** One line of the receipt — feeds the Costs panel's itemized ("ticket") split. */
export const receiptLineItemSchema = z.object({
  name: z.string(),
  price: z.number(),
  quantity: z.number().nullable().optional(),
});
export type ReceiptLineItem = z.infer<typeof receiptLineItemSchema>;

/**
 * One scanned receipt, as returned by the scan endpoint and sent back (possibly
 * edited by the user) to confirm. Everything except the amount is optional — a
 * crumpled till roll may only yield a total, and that is still a usable expense.
 *
 * `needs_review` is set by the mapper when a field the user really should check
 * is missing or implausible (no total, no date, no merchant).
 */
export const receiptScanItemSchema = z.object({
  doc_type: receiptDocTypeSchema,
  /** Fixed Costs category, pre-filled from doc_type; the user may override it. */
  category: z.string(),
  /** Expense name — the merchant, falling back to a type label. */
  title: z.string().min(1),
  merchant: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  /** Purchase date, YYYY-MM-DD (budget_items.expense_date). */
  date: z.string().nullable().optional(),
  /** Local time on the receipt, HH:MM — used for the reservation's start time. */
  time: z.string().nullable().optional(),
  total: z.number(),
  currency: z.string().nullable().optional(),
  confirmation_number: z.string().nullable().optional(),
  /** Accommodation: stay range, ISO local strings. */
  check_in: z.string().nullable().optional(),
  check_out: z.string().nullable().optional(),
  /** Transport/flight: endpoints as printed on the ticket. */
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  departure_time: z.string().nullable().optional(),
  arrival_time: z.string().nullable().optional(),
  /** Airline / rail operator / bus company. */
  carrier: z.string().nullable().optional(),
  /** Which kind of transport the ticket is, as read by the model. */
  transport_mode: z.enum(RECEIPT_TRANSPORT_MODES).nullable().optional(),
  /** Flight or train number as printed. */
  travel_number: z.string().nullable().optional(),
  line_items: z.array(receiptLineItemSchema).optional(),
  needs_review: z.boolean().optional(),
  source: z.object({ fileName: z.string(), index: z.number() }),
});
export type ReceiptScanItem = z.infer<typeof receiptScanItemSchema>;

/** Per-file note in the scan response — which file produced what, and whether AI ran. */
export const receiptScanFileReportSchema = z.object({
  fileName: z.string(),
  items: z.number(),
  /**
   * Why this file produced nothing, when a provider refused it. The `warnings`
   * array carries the same thing in English for the log and for a locale TREK
   * does not ship; this is what the panel translates.
   */
  failureCode: z.enum(['noVision', 'contextTooSmall', 'authRejected', 'rateLimited', 'unreachable', 'rejected']).optional(),
});
export type ReceiptScanFileReport = z.infer<typeof receiptScanFileReportSchema>;

export const receiptScanResponseSchema = z.object({
  /**
   * Handle for the uploaded bytes, held server-side for the length of the review
   * so confirm can file the receipt as a trip document without a re-upload.
   */
  scanId: z.string(),
  items: z.array(receiptScanItemSchema),
  warnings: z.array(z.string()),
  files: z.array(receiptScanFileReportSchema).optional(),
});
export type ReceiptScanResponse = z.infer<typeof receiptScanResponseSchema>;

/**
 * One reviewed receipt on its way to being persisted: the (edited) scan item
 * plus the choices the review step offers.
 */
export const receiptConfirmItemSchema = receiptScanItemSchema.extend({
  /** Also create the reservation/accommodation this document describes. */
  create_reservation: z.boolean().optional(),
  /** File the receipt image/PDF in the trip's documents and link it to the expense. */
  attach_receipt: z.boolean().optional(),
  /** Who fronted the bill (amounts in the receipt currency). Defaults to the caller. */
  payers: z.array(z.object({ user_id: z.number(), amount: z.number() })).optional(),
  /** Who the expense is split between. Defaults to no split (as a manual expense does). */
  member_ids: z.array(z.number()).optional(),
  /**
   * Per-person shares, as the manual expense form sends them: `null` for an
   * equal split, an amount for a custom or itemized one. `member_ids` alone
   * still works — an older client that only knows how to tick names keeps
   * splitting equally.
   */
  members: z.array(z.object({ user_id: z.number(), amount: z.number().nullable().optional() })).optional(),
  /** The note the reviewer typed, kept apart from the itemized receipt below. */
  note: z.string().nullable().optional(),
  /**
   * The receipt's lines (budget_items.ticket_json), kept whether or not they
   * divide the money — that is `split_mode`. Absent means an older client, and
   * for it the server still seeds the lines from what it read.
   */
  ticket_json: z.string().nullable().optional(),
  /** How the reviewer chose to divide the total. */
  split_mode: expenseSplitModeSchema.nullable().optional(),
});
export type ReceiptConfirmItem = z.infer<typeof receiptConfirmItemSchema>;

/**
 * The text fields alongside the uploaded files on the async scan.
 *
 * Multipart carries everything as strings, so the flag arrives as "true" rather
 * than a boolean. Only an explicit "true" shortens the read — anything else,
 * including the field being absent, is the full one.
 */
export const receiptScanOptionsSchema = z.object({
  quick: z.string().optional(),
});
export type ReceiptScanOptions = z.infer<typeof receiptScanOptionsSchema>;

export const receiptConfirmRequestSchema = z.object({
  scanId: z.string().optional(),
  items: z.array(receiptConfirmItemSchema).min(1),
});
export type ReceiptConfirmRequest = z.infer<typeof receiptConfirmRequestSchema>;

/** What one confirmed receipt produced. `reservation`/`file` are absent when not requested. */
export const receiptConfirmResultSchema = z.object({
  budget_item: z.record(z.string(), z.unknown()),
  reservation: z.record(z.string(), z.unknown()).nullable().optional(),
  file: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ReceiptConfirmResult = z.infer<typeof receiptConfirmResultSchema>;

export const receiptConfirmResponseSchema = z.object({
  created: z.array(receiptConfirmResultSchema),
  warnings: z.array(z.string()).optional(),
});
export type ReceiptConfirmResponse = z.infer<typeof receiptConfirmResponseSchema>;

/**
 * JSON Schema handed to the LLM providers' structured-output entry points
 * (OpenAI-compatible `response_format`, Anthropic tool `input_schema`).
 * Deliberately flat: a receipt has no nesting worth modelling, and small local
 * models fill a flat object far more reliably than a nested one.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    receipts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          doc_type: { type: 'string', enum: [...RECEIPT_DOC_TYPES] },
          merchant: { type: 'string' },
          address: { type: 'string' },
          date: { type: 'string', description: 'Purchase date, YYYY-MM-DD' },
          time: { type: 'string', description: 'Time printed on the receipt, HH:MM' },
          total: { type: 'number', description: 'Grand total actually paid' },
          currency: { type: 'string', description: 'ISO 4217 code, e.g. EUR' },
          confirmation_number: { type: 'string' },
          check_in: { type: 'string' },
          check_out: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          departure_time: { type: 'string' },
          arrival_time: { type: 'string' },
          carrier: { type: 'string' },
          transport_mode: { type: 'string', enum: [...RECEIPT_TRANSPORT_MODES] },
          travel_number: { type: 'string' },
          line_items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                price: { type: 'number' },
                quantity: { type: 'number' },
              },
              required: ['name', 'price'],
            },
          },
        },
        required: ['doc_type', 'total'],
      },
    },
  },
  required: ['receipts'],
} as const;

/** Lenient validator for one raw model node — the mapper tolerates missing fields. */
export const rawReceiptSchema = z.object({}).catchall(z.unknown());
