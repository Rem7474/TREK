import { RECEIPT_DOC_TYPES, RECEIPT_JSON_SCHEMA, RECEIPT_TRANSPORT_MODES } from '@trek/shared';

export { RECEIPT_JSON_SCHEMA };

/** Root key of the receipt structured output — the array the clients read. */
export const RECEIPT_ROOT_KEY = 'receipts';

/**
 * System instructions for the receipt scanner: classify the document, then pull
 * out the money and the few type-specific fields the confirm step needs to build
 * a reservation. Deliberately flat and short — receipts are photographed under
 * bad light and the model does better with a small, explicit field list than
 * with the nested schema.org shape the booking import uses. Pure (no I/O) so
 * it's unit-testable.
 */
export function buildReceiptPrompt(today: Date = new Date()): string {
  const todayIso = today.toISOString().slice(0, 10);
  return [
    'You read a receipt, bill or invoice (often a photo of a paper till roll, possibly crumpled, skewed or in a foreign language).',
    'Return ONLY a JSON object of the form { "receipts": [ ... ] } — no prose, no markdown.',
    'Emit ONE object per receipt in the document (usually exactly one).',
    'First classify the document. "doc_type" is one of:',
    RECEIPT_DOC_TYPES.map((t) => `  - ${t}`).join('\n'),
    'Classification hints:',
    '  meal        — restaurant, café, bar, takeaway, room service',
    '  groceries   — supermarket, market stall, convenience store',
    '  accommodation — hotel, hostel, B&B, apartment/holiday rental folio or invoice',
    '  transport   — train, bus, metro, tram, ferry, taxi/ride-hailing, car rental, parking, toll',
    '  flight      — airline ticket, boarding pass receipt, baggage or seat fee',
    '  fuel        — petrol/diesel/EV charging',
    '  activity    — museum, tour, excursion, show, attraction ticket',
    '  shopping    — retail goods, souvenirs, clothing, pharmacy goods',
    '  health      — pharmacy prescription, doctor, clinic, insurance claim',
    '  fees        — bank/ATM/visa/service fees',
    '  other       — anything that fits none of the above',
    'Always fill "total" (the grand total actually paid, after tax and tip — the largest "TOTAL"/"AMOUNT DUE" line, NOT the subtotal) and "currency" (ISO 4217, inferred from the symbol and the country when not printed).',
    'Fill "merchant" with the business name printed at the top, "address" with its street address, "date" as YYYY-MM-DD and "time" as HH:MM (24h).',
    'A date printed as DD/MM/YYYY or MM/DD/YYYY must be normalized to YYYY-MM-DD; use the country of the merchant to resolve the ambiguity.',
    // A till roll prints "26-08-23" and means one of three things. The merchant's
    // country settles DD/MM vs MM/DD, but nothing on the paper settles which pair
    // is the year — and a receipt is nearly always scanned soon after it is paid,
    // so the reading closest to today is the one to take.
    `Today is ${todayIso}. A receipt is scanned within days or weeks of payment, so when a two-digit or otherwise ambiguous date could be read several ways, choose the reading nearest to today; never choose one in the future.`,
    'Also fill "confirmation_number" (booking/reference/invoice number) when the document shows one.',
    'For accommodation, add "check_in" and "check_out" as ISO local date-times (e.g. "2026-06-11T15:00:00").',
    'For transport and flight, add "from" and "to" (station/airport/city as printed), "departure_time"/"arrival_time" as ISO local date-times, "carrier" (airline, rail or bus operator) and "travel_number" (flight/train number).',
    `Also set "transport_mode" to what the operator actually runs, one of: ${RECEIPT_TRANSPORT_MODES.join(', ')}. Judge it from the carrier and the ticket, not from the words printed on it — "Comboios de Portugal" and "Renfe" are train, "Bolt" and "FreeNow" are taxi, a metro or travelcard is transit.`,
    'Fill "line_items" with the itemized lines when the receipt lists them: { "name", "price", "quantity" }. Prices are per line as printed. Skip discount/subtotal/tax/total lines.',
    'Never invent a value: leave a field out when the document does not show it. Numbers are plain numbers (12.5, not "12,50 €").',
    'If the image is unreadable or shows no receipt at all, return { "receipts": [] }.',
  ].join('\n');
}

/** Short user-turn instruction that accompanies the document content. */
export const RECEIPT_USER_INSTRUCTION = 'Extract the receipt(s) in this document as JSON.';
