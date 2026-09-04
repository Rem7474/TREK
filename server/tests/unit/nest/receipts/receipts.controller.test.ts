import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptsController } from '../../../../src/nest/receipts/receipts.controller';
import type { ReceiptsService } from '../../../../src/nest/receipts/receipts.service';
import type { User } from '../../../../src/types';

const user = { id: 1, role: 'user' } as User;
const file = (name = 'receipt.jpg') => ({ originalname: name, buffer: Buffer.from('x') } as Express.Multer.File);

const item = {
  doc_type: 'meal',
  category: 'food',
  title: 'Chez Marcel',
  total: 42,
  source: { fileName: 'receipt.jpg', index: 0 },
};


function make(over: Partial<ReceiptsService> = {}, demo = false) {
  const svc = {
    isAvailable: vi.fn(() => true),
    scan: vi.fn(async () => ({ scanId: 's1', items: [], warnings: [], files: [] })),
    confirm: vi.fn(async () => ({ created: [], warnings: [] })),
    ...over,
  } as unknown as ReceiptsService;
  // Trip access and 'budget_edit' are the guard chain's job now, so what is left
  // to test here is the demo lock, the LLM precondition and the upload rules.
  const auth = { isDemoUser: vi.fn(() => demo) } as never;
  const scanJobs = { start: vi.fn(() => 'job-1'), get: vi.fn() } as never;
  return { c: new ReceiptsController(svc, scanJobs, auth), svc, scanJobs };
}

async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    return (err as HttpException).getStatus();
  }
  throw new Error('expected throw');
}

beforeEach(() => vi.clearAllMocks());

describe('ReceiptsController.scan/async', () => {
  it('hands back a job id instead of waiting for the model', async () => {
    const { c, scanJobs, svc } = make();

    await expect(c.scanAsync(user, 't1', [file('IMG_0421.HEIC')])).resolves.toEqual({ jobId: 'job-1' });

    // The point of the endpoint: the request does not carry the inference.
    expect(svc.scan).not.toHaveBeenCalled();
    expect(scanJobs.start).toHaveBeenCalledWith('t1', [expect.anything()], 1);
  });


  it('refuses before it starts anything: demo, no model, no file, wrong file', async () => {
    // Checked in the handler rather than in a guard — a guard on a multipart route
    // hands the client an ECONNRESET instead of the status (PROFILE-015).
    expect(await status(() => make({}, true).c.scanAsync(user, 't1', [file()]))).toBe(403);
    expect(await status(() => make({ isAvailable: vi.fn(() => false) as never }).c.scanAsync(user, 't1', [file()]))).toBe(409);
    expect(await status(() => make().c.scanAsync(user, 't1', []))).toBe(400);
    expect(await status(() => make().c.scanAsync(user, 't1', [file('holiday.mp4')]))).toBe(400);
  });

  it('takes a phone photo — HEIC included — and hands it straight to the job', async () => {
    const { c, scanJobs } = make();
    await c.scanAsync(user, 't1', [file('IMG_0421.HEIC')]);
    expect(scanJobs.start).toHaveBeenCalledWith('t1', [expect.anything()], 1);
  });

  it('404s a job that expired or belongs to somebody else', async () => {
    const { c } = make();
    expect(await status(async () => c.jobStatus(user, 'nope'))).toBe(404);
  });

  it('reports a finished job to a client that reconnected', () => {
    const { c, scanJobs } = make();
    (scanJobs.get as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'done', done: 1, total: 1, result: { scanId: 's1', items: [], warnings: [], files: [] },
    });

    expect(c.jobStatus(user, 'job-1')).toEqual({
      status: 'done', done: 1, total: 1, result: { scanId: 's1', items: [], warnings: [], files: [] }, error: undefined,
    });
  });
});

describe('ReceiptsController.confirm', () => {
  it('passes the scan id, items and socket id through', async () => {
    const { c, svc } = make();
    await c.confirm(user, 't1', { scanId: 's1', items: [item] } as never, 'socket-9');
    expect(svc.confirm).toHaveBeenCalledWith('t1', user, 's1', [expect.objectContaining({ title: 'Chez Marcel' })], 'socket-9');
  });

});
