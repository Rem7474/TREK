import { beforeEach, describe, expect, it, vi } from 'vitest';

// The collaborators are constructor deps since the receipts module was written
// against the Nest DI layout, so they are stubbed positionally rather than by
// mocking module paths — only the two genuine side effects (disk, the global db
// the DatabaseService wraps) still need a module mock.
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../../../src/db/database', () => ({
  db: { prepare: () => ({ run, get: () => ({ id: 10 }) }) },
  closeDb: () => {},
  reinitialize: () => {},
  canAccessTrip: vi.fn(),
  isOwner: () => false,
  getPlaceWithTags: () => null,
}));

vi.mock('../../../../src/nest/files/files.constants', () => ({
  filesDir: '/tmp/trek-test-files',
  DEFAULT_ALLOWED_EXTENSIONS: '',
}));

const { writeFileSync, existsSync, mkdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));
vi.mock('node:fs', () => ({ default: { writeFileSync, existsSync, mkdirSync } }));

import { db as dbConn } from '../../../../src/db/database';
import { DatabaseService } from '../../../../src/nest/database/database.service';

import { ReceiptsService } from '../../../../src/nest/receipts/receipts.service';
import { ReceiptScanStore } from '../../../../src/nest/receipts/receipt-scan.store';
import type { LlmParseService } from '../../../../src/nest/llm-parse/llm-parse.service';
import type { ReceiptConfirmItem } from '@trek/shared';
import type { User } from '../../../../src/types';

const user = { id: 1, role: 'user' } as User;

const meal = (over: Partial<ReceiptConfirmItem> = {}): ReceiptConfirmItem => ({
  doc_type: 'meal',
  category: 'food',
  title: 'Chez Marcel',
  merchant: 'Chez Marcel',
  date: '2026-06-11',
  total: 86.4,
  currency: 'EUR',
  source: { fileName: 'receipt.jpg', index: 0 },
  ...over,
});

const createBudgetItem = vi.fn((_tripId: unknown, data: Record<string, unknown>) => ({ id: 99, ...data }));
const freezeForeignRate = vi.fn(async () => {});
const createReservation = vi.fn(() => ({ reservation: { id: 7 }, accommodationCreated: true }));
const setReservationTravelers = vi.fn();
const createPlace = vi.fn(() => ({ id: 3, name: 'Hotel Napoleon' }));
const searchNominatim = vi.fn(async () => [{ lat: 48.87, lng: 2.29 }]);
const createFile = vi.fn(() => ({ id: 55, original_name: 'receipt.jpg' }));
const createFileLink = vi.fn();
const broadcast = vi.fn();

function make(llmOver: Partial<LlmParseService> = {}) {
  const llm = { isAvailable: vi.fn(() => true), parseReceipt: vi.fn(async () => ({ receipts: [], warnings: [] })), ...llmOver } as unknown as LlmParseService;
  const store = new ReceiptScanStore();
  const svc = new ReceiptsService(
    llm,
    store,
    new DatabaseService(dbConn),
    { createBudgetItem, freezeForeignRate } as never,
    { createFile, createFileLink } as never,
    { searchNominatim } as never,
    { checkPermission: vi.fn(() => true) } as never,
    { create: createPlace } as never,
    { broadcast } as never,
    { create: createReservation, setReservationTravelers } as never,
  );
  return { svc, llm, store };
}

beforeEach(() => vi.clearAllMocks());

describe('ReceiptsService.scan', () => {
  it('maps the model output and keeps the bytes for the confirm step', async () => {
    const { svc, store } = make({
      parseReceipt: vi.fn(async () => ({ receipts: [{ doc_type: 'meal', merchant: 'Chez Marcel', total: '86,40 €', date: '11/06/2026' }], warnings: [] })),
    } as never);

    const res = await svc.scan('1', [{ originalname: 'receipt.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('x') } as Express.Multer.File], 1);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ title: 'Chez Marcel', total: 86.4, category: 'food', date: '2026-06-11' });
    expect(res.files).toEqual([{ fileName: 'receipt.jpg', items: 1 }]);
    expect(store.getFile(res.scanId, '1', 1, 'receipt.jpg')).not.toBeNull();
  });

  it('warns when a file yielded nothing', async () => {
    const { svc } = make();
    const res = await svc.scan('1', [{ originalname: 'blank.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('x') } as Express.Multer.File], 1);
    expect(res.items).toEqual([]);
    expect(res.warnings[0]).toContain('no receipt found');
  });
});

describe('ReceiptsService.confirm', () => {
  it('creates the expense with the payer, split and frozen rate', async () => {
    const { svc } = make();
    const res = await svc.confirm('1', user, undefined, [meal({ payers: [{ user_id: 1, amount: 86.4 }], member_ids: [1, 2] })], true, undefined);

    expect(freezeForeignRate).toHaveBeenCalled();
    expect(createBudgetItem).toHaveBeenCalledWith('1', expect.objectContaining({
      category: 'food',
      name: 'Chez Marcel',
      total_price: 86.4,
      currency: 'EUR',
      expense_date: '2026-06-11',
      payers: [{ user_id: 1, amount: 86.4 }],
      member_ids: [1, 2],
    }));
    expect(res.created).toHaveLength(1);
    // A meal receipt is expense-only by default — nothing lands on the itinerary.
    expect(createReservation).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('1', 'budget:created', expect.anything(), undefined);
  });

  it('falls back to the doc type when the category is not a real one', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({ category: 'made-up' })], true, undefined);
    expect(createBudgetItem).toHaveBeenCalledWith('1', expect.objectContaining({ category: 'food' }));
  });

  it('defaults the payer to the person who scanned it', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal()], true, undefined);
    expect(createBudgetItem).toHaveBeenCalledWith('1', expect.objectContaining({ payers: [{ user_id: 1, amount: 86.4 }] }));
  });

  it('records an unpaid expense when the review says nobody paid', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({ payers: [] })], true, undefined);
    expect(createBudgetItem).toHaveBeenCalledWith('1', expect.objectContaining({ payers: [], total_price: 86.4 }));
  });

  it('creates the place, hotel reservation and accommodation for a stay', async () => {
    const { svc } = make();
    const res = await svc.confirm(
      '1',
      user,
      undefined,
      [meal({ doc_type: 'accommodation', category: 'accommodation', title: 'Hotel Napoleon', merchant: 'Hotel Napoleon', address: '40 av de Friedland', total: 420, check_in: '2026-06-11T15:00:00', check_out: '2026-06-14T11:00:00' })],
      true,
      undefined,
    );

    expect(createPlace).toHaveBeenCalledWith('1', expect.objectContaining({ name: 'Hotel Napoleon', lat: 48.87, lng: 2.29 }));
    expect(createReservation).toHaveBeenCalledWith('1', expect.objectContaining({
      type: 'hotel',
      status: 'confirmed',
      place_id: 3,
      create_accommodation: expect.objectContaining({ check_in: '2026-06-11T15:00:00', check_out: '2026-06-14T11:00:00', start_day_id: 10, end_day_id: 10 }),
    }));
    // The expense links back to the booking it paid for.
    expect(createBudgetItem).toHaveBeenCalledWith('1', expect.objectContaining({ reservation_id: 7 }));
    expect(res.created[0].reservation).toEqual({ id: 7 });
  });

  it('narrows a transport receipt to the mode its carrier names and titles it From → To', async () => {
    const { svc } = make();
    await svc.confirm(
      '1',
      user,
      undefined,
      [meal({ doc_type: 'transport', category: 'transport', title: 'SNCF', carrier: 'SNCF', from: 'Paris Gare de Lyon', to: 'Lyon Part-Dieu', departure_time: '2026-06-11T09:07:00' })],
      true,
      undefined,
    );

    expect(createReservation).toHaveBeenCalledWith('1', expect.objectContaining({
      type: 'train',
      title: 'Paris Gare de Lyon → Lyon Part-Dieu',
      reservation_time: '2026-06-11T09:07:00',
      endpoints: [
        { role: 'from', sequence: 0, name: 'Paris Gare de Lyon', lat: 48.87, lng: 2.29 },
        { role: 'to', sequence: 1, name: 'Lyon Part-Dieu', lat: 48.87, lng: 2.29 },
      ],
    }));
  });

  it('keeps the expense but warns when the user may not create reservations', async () => {
    const { svc } = make();
    const res = await svc.confirm('1', user, undefined, [meal({ doc_type: 'accommodation', create_reservation: true })], false, undefined);

    expect(createReservation).not.toHaveBeenCalled();
    expect(createBudgetItem).toHaveBeenCalled();
    expect(res.warnings?.[0]).toContain('no reservation permission');
  });

  it('files the receipt as a trip document and links it to the expense', async () => {
    const { svc, store } = make();
    const scanId = store.put('1', 1, [{ originalName: 'receipt.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('bytes') }]);

    const res = await svc.confirm('1', user, scanId, [meal()], true, undefined);

    expect(writeFileSync).toHaveBeenCalled();
    expect(createFile).toHaveBeenCalledWith('1', expect.objectContaining({ originalname: 'receipt.jpg', size: 5 }), 1, expect.objectContaining({ description: 'Receipt — Chez Marcel' }));
    expect(run).toHaveBeenCalledWith(55, 99);
    expect(res.created[0].file).toMatchObject({ id: 55 });
    // The bytes are released once the review is over.
    expect(store.getFile(scanId, '1', 1, 'receipt.jpg')).toBeNull();
  });

  it('still books the expense when the held bytes have expired, and says the image is missing', async () => {
    const { svc } = make();
    // A scan id whose files the store has already let go: the review sat in the
    // background tray longer than the bytes are kept.
    const res = await svc.confirm('1', user, 'gone', [meal()], true, undefined);

    expect(createFile).not.toHaveBeenCalled();
    expect(res.created).toHaveLength(1);
    expect(res.warnings?.[0]).toContain('no longer available');
  });

  it('skips the document when the user opted out', async () => {
    const { svc, store } = make();
    const scanId = store.put('1', 1, [{ originalName: 'receipt.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('bytes') }]);

    await svc.confirm('1', user, scanId, [meal({ attach_receipt: false })], true, undefined);
    expect(createFile).not.toHaveBeenCalled();
  });

  it('stores the split the reviewer sent, and nothing it did not', async () => {
    // The review screen always reports a split (ReceiptScanModal reports on mount),
    // so the lines are its answer to give. Re-deriving them here would be a second
    // copy of the rule in useExpenseSplit, drifting the moment either side changed.
    const { svc } = make();
    const ticket = JSON.stringify({ items: [{ name: 'Pasta', price: '12', parts: [1, 2] }] });
    await svc.confirm('1', user, undefined, [meal({ total: 30, member_ids: [1, 2], ticket_json: ticket })], true, undefined);

    expect((createBudgetItem.mock.calls[0][1] as { ticket_json: string }).ticket_json).toBe(ticket);
  });

  it('leaves the lines alone when the reviewer sent none, rather than inventing them', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({ total: 30, line_items: [{ name: 'Pasta', price: 12 }] })], true, undefined);

    expect((createBudgetItem.mock.calls[0][1] as { ticket_json: string | null }).ticket_json).toBeNull();
  });

  it('takes the split the reviewer chose over the receipt lines', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({
      total: 30,
      member_ids: [1, 2],
      members: [{ user_id: 1, amount: 20 }, { user_id: 2, amount: 10 }],
      note: '  dinner with Ana  ',
      ticket_json: null,
      line_items: [{ name: 'Pasta', price: 12 }, { name: 'Wine', price: 15 }],
    })], true, undefined);

    const data = createBudgetItem.mock.calls[0][1] as { ticket_json: string | null; note: string | null; members: unknown };
    expect(data.ticket_json).toBeNull();
    expect(data.note).toBe('dinner with Ana');
    expect(data.members).toEqual([{ user_id: 1, amount: 20 }, { user_id: 2, amount: 10 }]);
  });

  it('keeps going after one receipt fails', async () => {
    createBudgetItem.mockImplementationOnce(() => { throw new Error('db down'); });
    const { svc } = make();
    const res = await svc.confirm('1', user, undefined, [meal({ title: 'Broken' }), meal({ title: 'Fine' })], true, undefined);

    expect(res.created).toHaveLength(1);
    expect(res.warnings?.[0]).toContain('Broken');
  });
});

describe('ReceiptsService.confirm — the meal on the itinerary', () => {
  it('records the printed time as when the table was left, not taken', async () => {
    // A till receipt is printed when the bill is paid. Filed as the start, a
    // lunch appeared on the timeline at the hour it ended.
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({ date: '2026-08-25', time: '12:41', create_reservation: true })], true, undefined);

    const payload = createReservation.mock.calls[0][1] as { reservation_time?: string; reservation_end_time?: string; day_id?: number };
    expect(payload.reservation_end_time).toBe('2026-08-25T12:41:00');
    expect(payload.reservation_time).toBeUndefined();
    // No start means nothing to place it by, so the day is set outright.
    expect(payload.day_id).toBeDefined();
  });

  it('seats whoever the bill is split between, so nobody ticks the same names twice', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({ create_reservation: true, member_ids: [1, 2] })], true, undefined);

    expect(setReservationTravelers).toHaveBeenCalledWith(7, '1', [1, 2]);
  });

  it('falls back to the payers when nobody shares the expense', async () => {
    const { svc } = make();
    await svc.confirm('1', user, undefined, [meal({
      create_reservation: true,
      member_ids: [],
      payers: [{ user_id: 4, amount: 20 }, { user_id: 5, amount: 0 }],
    })], true, undefined);

    // The one who paid nothing was not at the table as far as the receipt knows.
    expect(setReservationTravelers).toHaveBeenCalledWith(7, '1', [4]);
  });
});
