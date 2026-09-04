import { describe, expect, it } from 'vitest';
import { ReceiptScanStore } from '../../../../src/nest/receipts/receipt-scan.store';

const files = [{ originalName: 'receipt.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('bytes') }];

describe('ReceiptScanStore', () => {
  it('hands back a file stored under its scan id', () => {
    const store = new ReceiptScanStore();
    const id = store.put('t1', 1, files);
    expect(store.getFile(id, 't1', 1, 'receipt.jpg')?.buffer.toString()).toBe('bytes');
  });

  it('does not leak a scan to another user or trip', () => {
    const store = new ReceiptScanStore();
    const id = store.put('t1', 1, files);
    expect(store.getFile(id, 't1', 2, 'receipt.jpg')).toBeNull();
    expect(store.getFile(id, 't2', 1, 'receipt.jpg')).toBeNull();
  });

  it('returns null for an unknown file name, scan id, or no scan id', () => {
    const store = new ReceiptScanStore();
    const id = store.put('t1', 1, files);
    expect(store.getFile(id, 't1', 1, 'other.jpg')).toBeNull();
    expect(store.getFile('nope', 't1', 1, 'receipt.jpg')).toBeNull();
    expect(store.getFile(undefined, 't1', 1, 'receipt.jpg')).toBeNull();
  });

  it('releases the bytes once the review is done', () => {
    const store = new ReceiptScanStore();
    const id = store.put('t1', 1, files);
    store.drop(id);
    expect(store.getFile(id, 't1', 1, 'receipt.jpg')).toBeNull();
  });
});
