import { Injectable } from '@nestjs/common';

import { randomUUID } from 'node:crypto';

/** One uploaded receipt held between the scan and the confirm. */
export interface StoredReceiptFile {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

interface StoredScan {
  userId: number;
  tripId: string;
  files: StoredReceiptFile[];
  expiresAt: number;
}

/** How long a scan's bytes stay available for the review step. */
const SCAN_TTL_MS = 30 * 60_000;
/** Hard cap on concurrently held scans, so a stuck client can't grow memory forever. */
const MAX_SCANS = 200;

/**
 * Holds the uploaded receipt bytes for the length of the review, keyed by the
 * `scanId` the scan endpoint returns. The confirm step needs them to file the
 * receipt as a trip document — keeping them here means the user reviews and
 * confirms without re-uploading the photo.
 *
 * In-memory and short-lived on purpose (same trade-off as ImportJobsService):
 * a restart mid-review just loses the attachment, and confirm still creates the
 * expense — it degrades, it doesn't fail.
 *
 * Known cost, should this ever be worth changing: RAM is what makes the TTL short
 * and MAX_SCANS necessary, so a busy server can drop a review's image before its
 * half hour is up, and a redeploy drops every one of them. Writing straight into
 * uploads/files instead is NOT the fix — that publishes a trip document, broadcast
 * to every member, for a scan nobody has confirmed. A staging directory would be:
 * bytes plus a small manifest under uploads/receipt-staging/<scanId>/, the reader
 * streaming file by file rather than holding all of them, confirm MOVING the file
 * into uploads/files and creating the document only then, and a sweep by directory
 * mtime here and at boot. No schema change, no second copy of the metadata, and
 * the TTL could then be hours. The cost of that shape is an orphaned directory if
 * the sweep ever misses — visible and deletable, unlike an orphan in memory.
 */
@Injectable()
export class ReceiptScanStore {
  private readonly scans = new Map<string, StoredScan>();

  /** Store one scan's files and return its handle. */
  put(tripId: string, userId: number, files: StoredReceiptFile[]): string {
    this.evictExpired();
    if (this.scans.size >= MAX_SCANS) {
      // Drop the oldest rather than refuse the upload — the loser is a stale
      // review nobody confirmed.
      const oldest = [...this.scans.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.scans.delete(oldest[0]);
    }
    const id = randomUUID();
    this.scans.set(id, { userId, tripId, files, expiresAt: Date.now() + SCAN_TTL_MS });
    return id;
  }

  /** The file a preview item came from, or null once the scan has expired. */
  getFile(scanId: string | undefined, tripId: string, userId: number, fileName: string): StoredReceiptFile | null {
    if (!scanId) return null;
    this.evictExpired();
    const scan = this.scans.get(scanId);
    if (!scan || scan.userId !== userId || scan.tripId !== String(tripId)) return null;
    return scan.files.find((f) => f.originalName === fileName) ?? null;
  }

  /** Release a scan once its review is over. */
  drop(scanId: string | undefined): void {
    if (scanId) this.scans.delete(scanId);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, scan] of this.scans) {
      if (scan.expiresAt <= now) this.scans.delete(id);
    }
  }
}
