import { describe, it, expect } from 'vitest';
import { buildReceiptPrompt, RECEIPT_LIST_JSON_SCHEMA, RECEIPT_ROOT_KEY, toReceiptRead } from '../../../../src/nest/llm-parse/receipt-read';

describe('toReceiptRead', () => {
  it('keeps a clean answer as it came', () => {
    expect(toReceiptRead({
      merchant: 'Café de Flore', date: '2026-09-20', total: 23.4, currency: 'EUR',
      items: [{ name: '2 x Espresso', price: 8 }, { name: 'Croque', price: 15.4 }],
    })).toEqual({
      merchant: 'Café de Flore', date: '2026-09-20', total: 23.4, currency: 'EUR',
      items: [{ name: '2 x Espresso', price: 8 }, { name: 'Croque', price: 15.4 }],
    });
  });

  it('reads amounts written as text, in either decimal convention', () => {
    expect(toReceiptRead({ total: '12,50 €' })?.total).toBe(12.5);
    expect(toReceiptRead({ total: '1.234,50' })?.total).toBe(1234.5);
    expect(toReceiptRead({ total: '1,234.50' })?.total).toBe(1234.5);
    expect(toReceiptRead({ total: 7, items: [{ name: 'Tea', price: '3,20' }] })?.items).toEqual([{ name: 'Tea', price: 3.2 }]);
  });

  it('turns a currency symbol or name into its code, and drops one nobody can convert', () => {
    expect(toReceiptRead({ total: 5, currency: '€' })?.currency).toBe('EUR');
    expect(toReceiptRead({ total: 5, currency: 'euros' })?.currency).toBe('EUR');
    expect(toReceiptRead({ total: 5, currency: 'Lek' })?.currency).toBeNull();
  });

  it('keeps only a real calendar date', () => {
    expect(toReceiptRead({ total: 5, date: '2026-02-28' })?.date).toBe('2026-02-28');
    for (const date of ['2026-02-30', '28/02/2026', '2026-2-8', '']) expect(toReceiptRead({ total: 5, date })?.date).toBeNull();
  });

  it('leaves out a total that is not a positive amount, and lines without a name or price', () => {
    const read = toReceiptRead({ merchant: 'Shop', total: 0, items: [{ name: '', price: 2 }, { name: 'Bread' }, 'x', { name: 'Milk', price: 1.1 }] });
    expect(read).toEqual({ merchant: 'Shop', date: null, total: null, currency: null, items: [{ name: 'Milk', price: 1.1 }] });
  });

  it('is null when nothing usable came back', () => {
    for (const raw of [null, undefined, 'text', [], {}, { total: 'n/a', merchant: '  ' }]) expect(toReceiptRead(raw)).toBeNull();
  });
});

describe('the receipt prompt and schema', () => {
  it('pins today so an ambiguous date is read towards it', () => {
    expect(buildReceiptPrompt(new Date('2026-09-24T10:00:00Z'))).toContain('Today is 2026-09-24.');
  });

  it('wraps one receipt under the key the cloud clients read', () => {
    expect(RECEIPT_LIST_JSON_SCHEMA.required).toEqual([RECEIPT_ROOT_KEY]);
    expect(RECEIPT_LIST_JSON_SCHEMA.properties[RECEIPT_ROOT_KEY].items.required).toEqual(['merchant', 'date', 'total', 'currency', 'items']);
  });
});
