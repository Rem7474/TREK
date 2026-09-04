import type { User } from '../../types';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermission, TripAccessGuard } from '../permissions/trip-access.guard';
import { Trip } from '../permissions/trip.decorator';
import type { TripAccess } from '../database/database.service';
import { ReceiptConfirmDto } from './receipts.dto';
import { ReceiptScanJobsService } from './receipt-scan-jobs.service';
import { ReceiptsService } from './receipts.service';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { ReceiptConfirmResponse } from '@trek/shared';

import { memoryStorage } from 'multer';
import { extname } from 'node:path';

/** A receipt is a photo, a screenshot, a PDF invoice, or the text of an e-mailed one. */
const ACCEPTED_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
  '.gif',
  '.pdf',
  '.txt',
  '.html',
  '.htm',
  '.eml',
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const UPLOAD = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
};

/**
 * /api/trips/:tripId/receipts — scan a paid receipt into an expense.
 *
 * Two steps, mirroring the reservation import: `scan/async` reads the uploaded
 * files and hands back an editable preview without persisting anything, `confirm`
 * writes the subset the user accepted. Both need 'budget_edit'; creating the reservation
 * a receipt describes additionally needs 'reservation_edit' (missing it degrades
 * to an expense-only result with a warning, it doesn't reject the request).
 */
@Controller('api/trips/:tripId/receipts')
// TripAccessGuard resolves :tripId and 404s a trip the user cannot reach, then
// @RequirePermission('budget_edit') 403s — the same action string the budget
// routes use, so a receipt cannot write an expense the user could not type in.
@UseGuards(JwtAuthGuard, TripAccessGuard)
export class ReceiptsController {
  constructor(
    private readonly receipts: ReceiptsService,
    private readonly scanJobs: ReceiptScanJobsService,
    private readonly auth: AuthService,
  ) {}

  /** Preconditions for a scan, checked in the handler rather than in a guard. */
  private validateScan(user: User, files: Express.Multer.File[] | undefined): void {
    // Scanning uploads a file AND spends an LLM call on the instance's key —
    // same reasoning as the file uploader, which is closed on the demo (#823).
    if (this.auth.isDemoUser(user.id)) {
      throw new HttpException(
        { error: 'Receipt scanning is disabled in demo mode. Self-host TREK for full functionality.' },
        403,
      );
    }
    if (!this.receipts.isAvailable(user.id)) {
      throw new HttpException({ error: 'AI parsing is not configured' }, 409);
    }
    if (!files || files.length === 0) throw new HttpException({ error: 'No files uploaded' }, 400);
    for (const file of files) {
      if (!ACCEPTED_EXTS.has(extname(file.originalname).toLowerCase())) {
        throw new HttpException(
          { error: `Unsupported file type: ${file.originalname}. Accepted: JPG, PNG, WEBP, HEIC, PDF, TXT, HTML, EML` },
          400,
        );
      }
    }
  }

  /**
   * POST /api/trips/:tripId/receipts/scan/async
   * Accepts up to 5 receipt files, returns a job id immediately and reads them in
   * the background. Progress and the result are pushed over the user's WebSocket
   * (receipt:progress / receipt:done / receipt:error).
   *
   * There is no synchronous twin on purpose: a vision model on CPU outlasts any
   * proxy timeout, and the work has to survive the panel being closed. A second
   * door would be a slower way to lose the same scan.
   */
  @RequirePermission('budget_edit')
  @Post('scan/async')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, UPLOAD))
  async scanAsync(
    @CurrentUser() user: User,
    @Param('tripId') tripId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<{ jobId: string }> {
    this.validateScan(user, files);
    return { jobId: this.scanJobs.start(tripId, files!, user.id) };
  }

  /**
   * GET /api/trips/:tripId/receipts/scan/jobs/:jobId
   * Poll a background scan — the recovery path for a client that missed the
   * WebSocket push. 404 once the job has expired.
   */
  @Get('scan/jobs/:jobId')
  jobStatus(@CurrentUser() user: User, @Param('jobId') jobId: string) {
    const job = this.scanJobs.get(jobId, user.id);
    if (!job) throw new HttpException({ error: 'Job not found' }, 404);
    return { status: job.status, done: job.done, total: job.total, result: job.result, error: job.error };
  }

  /**
   * POST /api/trips/:tripId/receipts/confirm
   * Persists the reviewed receipts as expenses (plus reservations/documents).
   */
  @RequirePermission('budget_edit')
  @Post('confirm')
  async confirm(
    @CurrentUser() user: User,
    @Trip() trip: TripAccess,
    @Param('tripId') tripId: string,
    @Body() body: ReceiptConfirmDto,
    @Headers('x-socket-id') socketId?: string,
  ): Promise<ReceiptConfirmResponse> {
    return this.receipts.confirm(
      tripId,
      user,
      body.scanId,
      body.items,
      this.receipts.canEditReservations(trip, user),
      socketId,
    );
  }
}
