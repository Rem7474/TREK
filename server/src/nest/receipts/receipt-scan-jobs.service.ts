import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RealtimeService } from '../realtime/realtime.service';
import { ReceiptsService } from './receipts.service';
import type { ReceiptScanResponse, TrekWsPayload } from '@trek/shared';

type JobStatus = 'running' | 'done' | 'error';

interface ScanJob {
  id: string;
  tripId: string;
  userId: number;
  status: JobStatus;
  done: number;
  total: number;
  result?: ReceiptScanResponse;
  error?: string;
  createdAt: number;
}

/**
 * How long a finished job stays fetchable.
 *
 * The whole promise of scanning in the background is "go and do something else
 * while it reads", and on a CPU-only model the reading alone takes minutes — so
 * the window has to outlast a phone left in a pocket, not just a page reload.
 * Matched to the scan store's own TTL so the result and the bytes it refers to
 * expire together rather than leaving a review that can no longer file its image.
 */
const JOB_TTL_MS = 30 * 60_000;

/**
 * Runs a receipt scan OFF the request.
 *
 * Reading a photograph is the slowest thing TREK asks of a model — a vision model
 * on CPU can sit well past any proxy's idle timeout on a single receipt — and the
 * work was tied to the upload request, so a timeout anywhere in the chain lost it,
 * and so did navigating away from the panel. Handing back a job id instead makes
 * the wall clock irrelevant: the scan continues here, progress and the result are
 * pushed to the user's sockets (which reach them on any page), and the outcome
 * survives ten minutes for a client that reconnects.
 *
 * Deliberately the same shape as the booking import's ImportJobsService, down to
 * the event payloads, so one background-task widget can follow either.
 */
@Injectable()
export class ReceiptScanJobsService {
  private readonly jobs = new Map<string, ScanJob>();
  /** Tail of each user's job chain — scans run one at a time per user, not all at once. */
  private readonly chains = new Map<number, Promise<void>>();

  constructor(
    private readonly receipts: ReceiptsService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Create a job and queue it behind the user's other scans; returns the job id at once. */
  start(tripId: string, files: Express.Multer.File[], userId: number): string {
    const id = randomUUID();
    const job: ScanJob = { id, tripId, userId, status: 'running', done: 0, total: files.length, createdAt: Date.now() };
    this.jobs.set(id, job);
    // Chain onto the user's previous scan so they run sequentially: two vision
    // inferences at once on one CPU is slower than the same two in a row.
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const next = prev.then(() => this.run(job, files)).catch(() => {});
    this.chains.set(userId, next);
    void next.finally(() => {
      if (this.chains.get(userId) === next) this.chains.delete(userId);
    });
    return id;
  }

  get(id: string, userId: number): ScanJob | undefined {
    const job = this.jobs.get(id);
    return job && job.userId === userId ? job : undefined;
  }

  private async run(job: ScanJob, files: Express.Multer.File[]): Promise<void> {
    this.push(job, 'receipt:progress', { status: 'running', done: 0, total: job.total });
    try {
      const result = await this.receipts.scan(
        job.tripId,
        files,
        job.userId,
        (done, total, fileName) => {
          job.done = done;
          this.push(job, 'receipt:progress', { status: 'running', done, total, fileName });
        },
      );
      job.status = 'done';
      job.result = result;
      this.push(job, 'receipt:done', { result });
    } catch (err) {
      job.status = 'error';
      // The provider's own body is already in the log; the socket carries the
      // sentence the panel can show.
      job.error = err instanceof Error ? err.message : String(err);
      this.push(job, 'receipt:error', { message: job.error });
    } finally {
      const id = job.id;
      setTimeout(() => this.jobs.delete(id), JOB_TTL_MS).unref?.();
    }
  }

  private push<E extends 'receipt:progress' | 'receipt:done' | 'receipt:error'>(
    job: ScanJob,
    type: E,
    payload: Omit<TrekWsPayload<E>, 'jobId' | 'tripId'>,
  ): void {
    // jobId/tripId are injected here; TS can't re-associate the spread with the
    // deferred generic payload, so re-assert the completed shape it just built.
    this.realtime.broadcastToUser(job.userId, {
      type,
      jobId: job.id,
      tripId: job.tripId,
      ...payload,
    } as { type: E } & TrekWsPayload<E>);
  }
}
