import { receiptConfirmRequestSchema } from '@trek/shared';
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
