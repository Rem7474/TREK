import {
  RECEIPT_DOC_TYPES,
  receiptDocTypeToCostCategory,
  type ReceiptDocType,
  type ReceiptLineItem,
  type ReceiptScanItem,
} from '@trek/shared';

/**
 * Turns the model's raw receipt objects into `ReceiptScanItem`s the review step
 * can show and the confirm step can persist. Pure (no I/O, no DB) so the whole
 * normalisation surface — money written as "12,50 €", DD/MM/YYYY dates, a
 * doc_type the model invented — is unit-testable without a provider.
 *
 * Tolerant by design, exactly like the kitinerary mapper: a receipt that only
 * yields a total is still a usable expense, so anything else missing produces a
 * `needs_review` flag rather than a dropped item.
 */

/** Fallback expense names per doc type when the receipt shows no merchant. */
const FALLBACK_TITLE: Record<ReceiptDocType, string> = {
  meal: 'Meal',
  groceries: 'Groceries',
  accommodation: 'Accommodation',
  transport: 'Transport',
  flight: 'Flight',
  fuel: 'Fuel',
  activity: 'Activity',
  shopping: 'Shopping',
  health: 'Health',
  fees: 'Fees',
  other: 'Receipt',
};

const DOC_TYPE_SET = new Set<string>(RECEIPT_DOC_TYPES);

/**
 * Money as printed: "12,50 €", "$1,234.56", "EUR 8.00". Returns null for
 * anything that isn't a finite positive-or-zero number.
 *
 * The comma/dot ambiguity is resolved by position: the LAST separator is the
 * decimal one when it is followed by 1-2 digits, which covers both "1,234.56"
 * and "1.234,56"; everything before it is a thousands separator and is dropped.
 */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const lastSep = Math.max(lastComma, lastDot);
  let normalized: string;
  if (lastSep === -1) {
    normalized = cleaned;
  } else if (cleaned.length - lastSep - 1 <= 2 && cleaned.length - lastSep - 1 >= 1) {
    // Decimal separator: strip every other separator, then standardise on a dot.
    normalized = cleaned.slice(0, lastSep).replace(/[.,]/g, '') + '.' + cleaned.slice(lastSep + 1);
  } else {
    // 3+ digits after the last separator — it groups thousands, not decimals.
    normalized = cleaned.replace(/[.,]/g, '');
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed non-empty string, or null. */
function str(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalise a date to YYYY-MM-DD. Accepts an ISO date/date-time and the
 * DD/MM/YYYY or MM/DD/YYYY forms receipts print. Ambiguous numeric dates are
 * read as day-first (the dominant convention outside the US) UNLESS the first
 * component can only be a month; a value that resolves to no real calendar date
 * returns null so the item is flagged for review rather than silently wrong.
 */
export function parseReceiptDate(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    // a > 12 → a is the day; b > 12 → a must be the month (US order). Otherwise
    // day-first, matching how most of the world prints a till roll.
    const [day, month] = b > 12 && a <= 12 ? [b, a] : [a, b];
    return isoDate(year, month, day);
  }

  return null;
}

/** Build YYYY-MM-DD, rejecting a combination that isn't a real date (31 Feb). */
function isoDate(year: number, month: number, day: number): string | null {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Normalise a time to HH:MM (24h), tolerating "7:05 PM" and an ISO date-time. */
export function parseReceiptTime(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const m = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** ISO 4217-ish currency, or null. Symbols the model left in are mapped back. */
export function parseCurrency(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const bySymbol: Record<string, string> = {
    '€': 'EUR',
    $: 'USD',
    '£': 'GBP',
    '¥': 'JPY',
    '₺': 'TRY',
    '₹': 'INR',
    CHF: 'CHF',
  };
  if (bySymbol[raw]) return bySymbol[raw];
  const code = raw.toUpperCase().replace(/[^A-Z]/g, '');
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** An ISO local date-time built from a date + optional time, for reservations. */
export function toLocalDateTime(date: string | null, time: string | null): string | null {
  if (!date) return null;
  return `${date}T${time ?? '00:00'}:00`;
}

function mapLineItems(value: unknown): ReceiptLineItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ReceiptLineItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = str(row.name);
    const price = parseMoney(row.price);
    if (!name || price == null) continue;
    const quantity = parseMoney(row.quantity);
    items.push({ name, price, ...(quantity != null && quantity > 0 ? { quantity } : {}) });
  }
  return items.length > 0 ? items : undefined;
}

/** Coerce whatever the model called the type into a known doc type. */
export function normalizeDocType(value: unknown): ReceiptDocType {
  const raw = (str(value) ?? '').toLowerCase();
  if (DOC_TYPE_SET.has(raw)) return raw as ReceiptDocType;
  // Common synonyms a model reaches for when it ignores the enum.
  if (/restaurant|food|dining|cafe|bar/.test(raw)) return 'meal';
  if (/hotel|lodging|stay|accom/.test(raw)) return 'accommodation';
  if (/train|bus|taxi|transit|parking|rental|ferry|transport/.test(raw)) return 'transport';
  if (/air|flight|plane/.test(raw)) return 'flight';
  if (/market|supermarket|grocer/.test(raw)) return 'groceries';
  if (/gas|petrol|diesel|fuel|charging/.test(raw)) return 'fuel';
  if (/museum|tour|ticket|attraction|activity|excursion/.test(raw)) return 'activity';
  if (/shop|retail|store|souvenir/.test(raw)) return 'shopping';
  if (/pharmac|health|medical|clinic|doctor/.test(raw)) return 'health';
  if (/fee|commission|charge/.test(raw)) return 'fees';
  return 'other';
}

/**
 * Map one file's worth of raw model output. Nodes without a usable total are
 * dropped with a warning — an expense with no amount is not worth creating.
 */
export function mapReceipts(
  raw: Record<string, unknown>[],
  fileName: string,
): { items: ReceiptScanItem[]; warnings: string[] } {
  const items: ReceiptScanItem[] = [];
  const warnings: string[] = [];

  raw.forEach((node, index) => {
    if (!node || typeof node !== 'object') return;

    const total = parseMoney(node.total);
    if (total == null || total <= 0) {
      warnings.push(`${fileName}: a scanned receipt had no readable total and was skipped`);
      return;
    }

    const docType = normalizeDocType(node.doc_type);
    const merchant = str(node.merchant);
    const date = parseReceiptDate(node.date);
    const time = parseReceiptTime(node.time);

    const item: ReceiptScanItem = {
      doc_type: docType,
      category: receiptDocTypeToCostCategory(docType),
      title: merchant ?? FALLBACK_TITLE[docType],
      merchant,
      address: str(node.address),
      date,
      time,
      total,
      currency: parseCurrency(node.currency),
      confirmation_number: str(node.confirmation_number),
      line_items: mapLineItems(node.line_items),
      // A receipt read off a photo is never as certain as a structured booking
      // file: flag the ones missing a field the user would want to fix.
      needs_review: !merchant || !date,
      source: { fileName, index },
    };

    items.push(item);
  });

  return { items, warnings };
}
