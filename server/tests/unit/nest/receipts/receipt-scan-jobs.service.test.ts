import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReceiptScanJobsService } from '../../../../src/nest/receipts/receipt-scan-jobs.service';
import type { ReceiptsService } from '../../../../src/nest/receipts/receipts.service';
import type { RealtimeService } from '../../../../src/nest/realtime/realtime.service';

const file = (name = 'receipt.jpg') => ({ originalname: name, buffer: Buffer.from('x') }) as Express.Multer.File;

function make(scan: ReceiptsService['scan']) {
  const broadcastToUser = vi.fn();
  const svc = new ReceiptScanJobsService(
    { scan } as unknown as ReceiptsService,
    { broadcastToUser } as unknown as RealtimeService,
  );
  return { svc, broadcastToUser };
}

/** Events pushed for one job, in order, as `type` strings. */
const types = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map(c => (c[1] as { type: string }).type);

beforeEach(() => vi.clearAllMocks());

describe('ReceiptScanJobsService', () => {
  it('returns a job id before the scan has run', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(r => { release = r; });
    const scan = vi.fn(async () => { await blocked; return { scanId: 's1', items: [], warnings: [], files: [] }; });
    const { svc } = make(scan as never);

    const id = svc.start('t1', [file()], 7);

    // The whole point: the caller has an id while the model is still reading.
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(svc.get(id, 7)?.status).toBe('running');
    release();
  });

  it('pushes progress then the result to the user, not the trip', async () => {
    const result = { scanId: 's1', items: [], warnings: [], files: [] };
    const scan = vi.fn(async (_t: string, _f: unknown, _u: number, onProgress?: (d: number, t: number, n: string) => void) => {
      onProgress?.(1, 2, 'receipt.jpg');
      return result;
    });
    const { svc, broadcastToUser } = make(scan as never);

    const id = svc.start('t1', [file(), file('b.jpg')], 7);
    await vi.waitFor(() => expect(svc.get(id, 7)?.status).toBe('done'));

    expect(types(broadcastToUser)).toEqual(['receipt:progress', 'receipt:progress', 'receipt:done']);
    expect(broadcastToUser.mock.calls[0][0]).toBe(7);
    expect(broadcastToUser.mock.calls.at(-1)?.[1]).toMatchObject({ jobId: id, tripId: 't1', result });
  });

  it('keeps the result readable after the scan, for a client that navigated away', async () => {
    const result = { scanId: 's1', items: [], warnings: [], files: [] };
    const { svc } = make(vi.fn(async () => result) as never);

    const id = svc.start('t1', [file()], 7);
    await vi.waitFor(() => expect(svc.get(id, 7)?.status).toBe('done'));

    expect(svc.get(id, 7)?.result).toEqual(result);
  });

  it('reports a failure as an error event rather than an unhandled rejection', async () => {
    const { svc, broadcastToUser } = make(vi.fn(async () => { throw new Error('model refused'); }) as never);

    const id = svc.start('t1', [file()], 7);
    await vi.waitFor(() => expect(svc.get(id, 7)?.status).toBe('error'));

    expect(types(broadcastToUser)).toEqual(['receipt:progress', 'receipt:error']);
    expect(broadcastToUser.mock.calls.at(-1)?.[1]).toMatchObject({ message: 'model refused' });
  });

  it('hides another user’s job', async () => {
    const { svc } = make(vi.fn(async () => ({ scanId: 's1', items: [], warnings: [], files: [] })) as never);
    const id = svc.start('t1', [file()], 7);
    expect(svc.get(id, 8)).toBeUndefined();
  });

  it('runs one user’s scans one at a time, so two photos do not fight for the CPU', async () => {
    let running = 0;
    let peak = 0;
    const scan = vi.fn(async () => {
      peak = Math.max(peak, ++running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return { scanId: 's1', items: [], warnings: [], files: [] };
    });
    const { svc } = make(scan as never);

    const a = svc.start('t1', [file()], 7);
    const b = svc.start('t1', [file()], 7);
    await vi.waitFor(() => {
      expect(svc.get(a, 7)?.status).toBe('done');
      expect(svc.get(b, 7)?.status).toBe('done');
    });

    expect(peak).toBe(1);
  });
});
