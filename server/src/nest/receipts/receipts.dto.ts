import { receiptConfirmRequestSchema, receiptScanOptionsSchema } from '@trek/shared';
import { createZodDto } from 'nestjs-zod';

/**
 * Server-side createZodDto wrapper for the receipt confirm body.
 *
 * Unlike the booking import's, this one adopts the shared schema verbatim: the
 * confirm items are what the scan step handed the client back, and every field
 * the service reads — the total it turns into an expense, the doc type it maps
 * to a category, the payers it must reconcile — is declared there. A caller that
 * omits one is a caller whose expense would be wrong.
 */
export class ReceiptConfirmDto extends createZodDto(receiptConfirmRequestSchema) {}


/**
 * The async scan's own body: the files travel as multipart, and this is what
 * rides alongside them. Small, but it goes through the same door as every other
 * mutation body — a handler reading @Body() without a contract is what the boot
 * ratchet exists to catch.
 */
export class ReceiptScanAsyncDto extends createZodDto(receiptScanOptionsSchema) {}
