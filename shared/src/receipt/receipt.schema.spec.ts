import { COST_CATEGORIES } from '../budget/budget.schema';
import {
  RECEIPT_DOC_TYPES,
  RECEIPT_JSON_SCHEMA,
  receiptConfirmRequestSchema,
  receiptCreatesReservationByDefault,
  receiptDocTypeToCostCategory,
  receiptDocTypeToReservationType,
  receiptScanItemSchema,
  receiptScanResponseSchema,
} from './receipt.schema';

import { describe, it, expect } from 'vitest';

const item = {
  doc_type: 'meal' as const,
  category: 'food',
  title: 'Chez Marcel',
  total: 86.4,
  source: { fileName: 'receipt.jpg', index: 0 },
};

describe('receiptScanItemSchema', () => {
  it('needs a type, a title, an amount and its source file', () => {
    expect(receiptScanItemSchema.safeParse(item).success).toBe(true);
    expect(receiptScanItemSchema.safeParse({ ...item, total: undefined }).success).toBe(false);
    expect(receiptScanItemSchema.safeParse({ ...item, title: '' }).success).toBe(false);
    expect(receiptScanItemSchema.safeParse({ ...item, source: undefined }).success).toBe(false);
  });

  it('rejects a document type the scanner does not classify', () => {
    expect(receiptScanItemSchema.safeParse({ ...item, doc_type: 'spaceship' }).success).toBe(false);
  });

  it('accepts a receipt that only yielded its total', () => {
    const bare = { ...item, merchant: null, date: null, currency: null, needs_review: true };
    expect(receiptScanItemSchema.safeParse(bare).success).toBe(true);
  });
});

describe('receiptConfirmRequestSchema', () => {
  it('requires at least one item', () => {
    expect(receiptConfirmRequestSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(receiptConfirmRequestSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('carries the review decisions and the split', () => {
    const parsed = receiptConfirmRequestSchema.safeParse({
      scanId: 's1',
      items: [
        {
          ...item,
          create_reservation: true,
          attach_receipt: false,
          payers: [{ user_id: 1, amount: 86.4 }],
          member_ids: [1, 2],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('receiptScanResponseSchema', () => {
  it('pairs the preview with the scan handle', () => {
    expect(receiptScanResponseSchema.safeParse({ scanId: 's1', items: [item], warnings: [] }).success).toBe(true);
    expect(receiptScanResponseSchema.safeParse({ items: [item], warnings: [] }).success).toBe(false);
  });
});

describe('receiptDocTypeToCostCategory', () => {
  it('maps every doc type to a real Costs category', () => {
    for (const type of RECEIPT_DOC_TYPES) {
      expect(COST_CATEGORIES).toContain(receiptDocTypeToCostCategory(type));
    }
  });

  it('falls back to other for an unknown or missing type', () => {
    expect(receiptDocTypeToCostCategory('spaceship')).toBe('other');
    expect(receiptDocTypeToCostCategory(null)).toBe('other');
  });
});

describe('receiptDocTypeToReservationType', () => {
  it('has nothing to put on the itinerary for pure purchases', () => {
    expect(receiptDocTypeToReservationType('groceries')).toBeNull();
    expect(receiptDocTypeToReservationType('shopping')).toBeNull();
    expect(receiptDocTypeToReservationType('fuel')).toBeNull();
  });

  it('maps a stay and a journey to their reservation types', () => {
    expect(receiptDocTypeToReservationType('accommodation')).toBe('hotel');
    expect(receiptDocTypeToReservationType('flight')).toBe('flight');
    expect(receiptDocTypeToReservationType('transport')).toBe('transport_other');
  });
});

describe('receiptCreatesReservationByDefault', () => {
  it('is on for a stay or a journey, off for money already spent', () => {
    expect(receiptCreatesReservationByDefault('accommodation')).toBe(true);
    expect(receiptCreatesReservationByDefault('transport')).toBe(true);
    expect(receiptCreatesReservationByDefault('meal')).toBe(false);
    expect(receiptCreatesReservationByDefault(null)).toBe(false);
  });
});

describe('RECEIPT_JSON_SCHEMA', () => {
  it('is an object root that enumerates the doc types the mapper knows', () => {
    expect(RECEIPT_JSON_SCHEMA.type).toBe('object');
    expect(RECEIPT_JSON_SCHEMA.properties.receipts.items.properties.doc_type.enum).toEqual([...RECEIPT_DOC_TYPES]);
  });

  it('makes the classification and the amount mandatory', () => {
    expect(RECEIPT_JSON_SCHEMA.properties.receipts.items.required).toEqual(['doc_type', 'total']);
  });
});
