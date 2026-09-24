import { z } from 'zod';

/**
 * A photographed receipt, as the AI model read it for the Costs tab.
 *
 * It only pre-fills the expense editor: nothing is saved until the person saves
 * the expense there, so every field may be missing and each is checked by eye.
 * There is no category: which kind of spending it was is the person's call.
 */
export const receiptLineSchema = z.object({
  name: z.string().min(1),
  /** What the line cost in total, quantity included, in the receipt's currency. */
  price: z.number(),
});
export type ReceiptLine = z.infer<typeof receiptLineSchema>;

export const receiptReadSchema = z.object({
  /** The business, which becomes the expense name. */
  merchant: z.string().min(1).nullable(),
  /** YYYY-MM-DD. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** The grand total paid. */
  total: z.number().positive().nullable(),
  /** ISO 4217. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  /** The itemized lines, which seed the Ticket split. */
  items: z.array(receiptLineSchema),
});
export type ReceiptRead = z.infer<typeof receiptReadSchema>;

/** What a finished receipt scan job answers: the read, or null with the reason in `warnings`. */
export const receiptScanResultSchema = z.object({
  receipt: receiptReadSchema.nullable(),
  warnings: z.array(z.string()),
});
export type ReceiptScanResult = z.infer<typeof receiptScanResultSchema>;

/** POST /api/trips/:tripId/budget/receipt-scan: the background job reading the photo. */
export const receiptScanStartResponseSchema = z.object({ jobId: z.string().min(1) });
export type ReceiptScanStartResponse = z.infer<typeof receiptScanStartResponseSchema>;
