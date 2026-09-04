import { describe, expect, it } from 'vitest';
import {
  mapReceipts,
  normalizeDocType,
  parseCurrency,
  parseMoney,
  parseReceiptDate,
  parseReceiptTime,
} from '../../../../src/nest/receipts/receipt-mapper';

describe('parseMoney', () => {
  it('reads a plain number through unchanged', () => {
    expect(parseMoney(12.5)).toBe(12.5);
  });

  it('reads the European comma decimal with a currency symbol', () => {
    expect(parseMoney('12,50 €')).toBe(12.5);
  });

  it('reads a US thousands separator', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
  });

  it('reads a European thousands separator', () => {
    expect(parseMoney('1.234,56')).toBe(1234.56);
  });

  it('treats a 3-digit group as thousands, not decimals', () => {
    expect(parseMoney('1.234')).toBe(1234);
  });

  it('returns null for a value with no digits', () => {
    expect(parseMoney('n/a')).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
  });
});

describe('parseReceiptDate', () => {
  it('keeps an ISO date', () => {
    expect(parseReceiptDate('2026-06-11')).toBe('2026-06-11');
  });

  it('trims an ISO date-time down to the date', () => {
    expect(parseReceiptDate('2026-06-11T19:30:00')).toBe('2026-06-11');
  });

  it('reads an ambiguous numeric date as day-first', () => {
    expect(parseReceiptDate('11/06/2026')).toBe('2026-06-11');
  });

  it('falls back to month-first when the second part cannot be a month', () => {
    expect(parseReceiptDate('06/25/2026')).toBe('2026-06-25');
  });

  it('expands a two-digit year', () => {
    expect(parseReceiptDate('11.06.26')).toBe('2026-06-11');
  });

  it('rejects a date that is not on the calendar', () => {
    expect(parseReceiptDate('31/02/2026')).toBeNull();
  });

  it('returns null for unparseable text', () => {
    expect(parseReceiptDate('yesterday')).toBeNull();
  });
});

describe('parseReceiptTime', () => {
  it('keeps a 24h time', () => {
    expect(parseReceiptTime('19:30')).toBe('19:30');
  });

  it('converts a PM time', () => {
    expect(parseReceiptTime('7:05 PM')).toBe('19:05');
  });

  it('converts midnight from 12 AM', () => {
    expect(parseReceiptTime('12:00 am')).toBe('00:00');
  });

  it('pulls the time out of an ISO date-time', () => {
    expect(parseReceiptTime('2026-06-11T09:07:00')).toBe('09:07');
  });
});

describe('parseCurrency', () => {
  it('maps a symbol back to its code', () => {
    expect(parseCurrency('€')).toBe('EUR');
  });

  it('uppercases a code', () => {
    expect(parseCurrency('eur')).toBe('EUR');
  });

  it('returns null for something that is not a code', () => {
    expect(parseCurrency('euros and cents')).toBeNull();
  });
});

describe('normalizeDocType', () => {
  it('keeps a known doc type', () => {
    expect(normalizeDocType('accommodation')).toBe('accommodation');
  });

  it('maps a synonym the model reached for', () => {
    expect(normalizeDocType('Restaurant')).toBe('meal');
    expect(normalizeDocType('hotel')).toBe('accommodation');
    expect(normalizeDocType('train ticket')).toBe('transport');
  });

  it('falls back to other for anything unrecognised', () => {
    expect(normalizeDocType('quantum')).toBe('other');
    expect(normalizeDocType(undefined)).toBe('other');
  });
});

describe('mapReceipts', () => {
  it('maps a restaurant bill to a food expense', () => {
    const { items, warnings } = mapReceipts(
      [
        {
          doc_type: 'meal',
          merchant: 'Chez Marcel',
          address: '3 rue de Rivoli, Paris',
          date: '11/06/2026',
          time: '20:15',
          total: '86,40 €',
          currency: '€',
          line_items: [{ name: 'Plat du jour', price: '24,00', quantity: 2 }],
        },
      ],
      'receipt.jpg',
    );

    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      doc_type: 'meal',
      category: 'food',
      title: 'Chez Marcel',
      date: '2026-06-11',
      time: '20:15',
      total: 86.4,
      currency: 'EUR',
      needs_review: false,
      source: { fileName: 'receipt.jpg', index: 0 },
    });
    expect(items[0].line_items).toEqual([{ name: 'Plat du jour', price: 24, quantity: 2 }]);
  });


  it('flags an item for review when the merchant or date is missing', () => {
    const { items } = mapReceipts([{ doc_type: 'meal', total: 12 }], 'blurry.jpg');
    expect(items[0].needs_review).toBe(true);
    expect(items[0].title).toBe('Meal');
  });

  it('skips a node with no readable total and warns', () => {
    const { items, warnings } = mapReceipts([{ doc_type: 'meal', merchant: 'X' }], 'blank.jpg');
    expect(items).toEqual([]);
    expect(warnings[0]).toContain('no readable total');
  });

  it('skips a zero total (a refunded or voided slip)', () => {
    const { items } = mapReceipts([{ doc_type: 'shopping', total: 0 }], 'void.jpg');
    expect(items).toEqual([]);
  });

  it('drops line items that carry no usable price', () => {
    const { items } = mapReceipts(
      [{ doc_type: 'groceries', merchant: 'Market', date: '2026-06-11', total: 10, line_items: [{ name: 'Bread' }, { name: 'Milk', price: 2 }] }],
      'market.jpg',
    );
    expect(items[0].line_items).toEqual([{ name: 'Milk', price: 2 }]);
  });

  it('ignores a non-object node', () => {
    const { items } = mapReceipts([null as unknown as Record<string, unknown>], 'x.jpg');
    expect(items).toEqual([]);
  });
});
