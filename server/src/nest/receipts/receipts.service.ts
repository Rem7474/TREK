import type { User } from '../../types';
import { BudgetService } from '../budget/budget.service';
import { DatabaseService } from '../database/database.service';
import { filesDir } from '../files/files.constants';
import { FilesService } from '../files/files.service';
import { LlmParseService } from '../llm-parse/llm-parse.service';
import { RealtimeService } from '../realtime/realtime.service';
import { mapReceipts } from './receipt-mapper';
import { ReceiptScanStore, type StoredReceiptFile } from './receipt-scan.store';
import { HttpException, Injectable } from '@nestjs/common';
import {
  receiptDocTypeToCostCategory,
  COST_CATEGORIES,
  type CostCategory,
  type ReceiptConfirmItem,
  type ReceiptConfirmResponse,
  type ReceiptConfirmResult,
  type ReceiptScanItem,
  type ReceiptScanResponse,
} from '@trek/shared';

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

const COST_CATEGORY_SET = new Set<string>(COST_CATEGORIES);

/**
 * Receipt scanning: photograph a bill → an LLM classifies it and reads the
 * amount → the confirmed result becomes an expense, with the receipt itself
 * filed as a trip document.
 *
 * The extraction reuses the booking import's provider plumbing (LlmParseService)
 * with a receipt-specific prompt and schema; the persistence reuses the existing
 * budget and file services, so a scanned expense is indistinguishable from a
 * hand-entered one.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly llmParse: LlmParseService,
    private readonly store: ReceiptScanStore,
    private readonly dbs: DatabaseService,
    private readonly budget: BudgetService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
  ) {}

  private get db() {
    return this.dbs.connection;
  }

  /** Receipts are read by a vision/text model — there is no non-AI fallback. */
  isAvailable(userId: number): boolean {
    return this.llmParse.isAvailable(userId);
  }

  /**
   * Read the uploaded receipts and return a preview. Persists nothing — the
   * bytes are held in the scan store so confirm can file them as documents.
   */
  async scan(
    tripId: string,
    files: Express.Multer.File[],
    userId: number,
    onProgress?: (done: number, total: number, fileName: string) => void,
  ): Promise<ReceiptScanResponse> {
    if (!this.llmParse.isAvailable(userId)) {
      throw new HttpException({ error: 'AI parsing is not configured' }, 409);
    }

    const items: ReceiptScanItem[] = [];
    const warnings: string[] = [];
    const fileReports: ReceiptScanResponse['files'] = [];
    const stored: StoredReceiptFile[] = [];

    for (const [index, file] of files.entries()) {
      onProgress?.(index, files.length, file.originalname);
      const { receipts, warnings: parseWarnings, failureCode } = await this.llmParse.parseReceipt(
        { buffer: file.buffer, originalName: file.originalname },
        userId,
      );
      warnings.push(...parseWarnings);

      const mapped = mapReceipts(receipts, file.originalname);
      warnings.push(...mapped.warnings);
      if (mapped.items.length === 0 && parseWarnings.length === 0) {
        warnings.push(`${file.originalname}: no receipt found`);
      }
      items.push(...mapped.items);
      fileReports.push({ fileName: file.originalname, items: mapped.items.length, failureCode });

      stored.push({ originalName: file.originalname, mimeType: file.mimetype, buffer: file.buffer });
    }

    const scanId = this.store.put(tripId, userId, stored);
    return { scanId, items, warnings, files: fileReports };
  }

  /**
   * Persist the reviewed receipts: the receipt document, then the expense that
   * links to it. A failure on one item is logged and the rest still go through —
   * same tolerance as the booking import's confirm.
   */
  async confirm(
    tripId: string,
    user: User,
    scanId: string | undefined,
    items: ReceiptConfirmItem[],
    socketId: string | undefined,
  ): Promise<ReceiptConfirmResponse> {
    const created: ReceiptConfirmResult[] = [];
    const warnings: string[] = [];

    for (const item of items) {
      try {
        const file = this.attachReceipt(tripId, user.id, scanId, item, socketId);
        // The bytes are held only for the length of the review. Someone who left
        // the scan sitting in the tray for half an hour still gets the expense —
        // they should just be told the image did not come with it.
        if (!file && item.attach_receipt !== false && scanId) {
          warnings.push(`${item.title}: the receipt image was no longer available`);
        }

        const budgetItem = await this.createExpense(tripId, user, item, file?.id);
        this.realtime.broadcast(tripId, 'budget:created', { item: budgetItem }, socketId);

        created.push({ budget_item: budgetItem as Record<string, unknown>, file });
      } catch (err) {
        console.error(`[receipts] Failed to confirm "${item.title}":`, err instanceof Error ? err.message : err);
        warnings.push(`${item.title}: could not be saved`);
      }
    }

    // The review is over — release the held bytes rather than wait for the TTL.
    this.store.drop(scanId);

    return { created, warnings };
  }

  /**
   * File the scanned image/PDF in the trip's documents so the expense keeps its
   * proof of purchase, linking it to the reservation when there is one. Returns
   * null when the bytes are gone (expired scan) or the user opted out —
   * attaching is a bonus, never a reason to lose the expense.
   */
  private attachReceipt(
    tripId: string,
    userId: number,
    scanId: string | undefined,
    item: ReceiptConfirmItem,
    socketId: string | undefined,
  ): (Record<string, unknown> & { id: number }) | null {
    if (item.attach_receipt === false) return null;
    const stored = this.store.getFile(scanId, tripId, userId, item.source.fileName);
    if (!stored) return null;

    try {
      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
      const filename = `${uuidv4()}${path.extname(stored.originalName)}`;
      fs.writeFileSync(path.join(filesDir, filename), stored.buffer);

      const file = this.files.createFile(
        tripId,
        {
          filename,
          originalname: stored.originalName,
          size: stored.buffer.length,
          mimetype: stored.mimeType,
        },
        userId,
        { description: `Receipt — ${item.title}` },
      );
      const document = file as Record<string, unknown> & { id: number };
      this.realtime.broadcast(tripId, 'file:created', { file }, socketId);
      return document;
    } catch (err) {
      console.error('[receipts] Failed to store the receipt document:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * The expense itself. The scanner defaults to "the person who scanned it paid
   * the whole bill", which is the overwhelmingly common case, and the review step
   * can override both the payers and who it's split between.
   */
  private async createExpense(
    tripId: string,
    user: User,
    item: ReceiptConfirmItem,
    receiptFileId: number | undefined,
  ) {
    // An explicit empty array means "nobody has paid yet" (the review step's
    // "no one paid" option) — only an ABSENT list falls back to the scanner.
    const payers = item.payers ?? [{ user_id: user.id, amount: item.total }];
    // The review step edits the split with the same editor as the Costs dialog
    // and always reports one, so its answer is taken as given — including a
    // deliberate null. Seeding the lines a second time here would be a second
    // copy of a rule that already lives in useExpenseSplit.
    const ticket = item.ticket_json ?? null;
    const data = {
      category: this.resolveCategory(item),
      name: item.title,
      total_price: item.total,
      currency: item.currency ?? null,
      expense_date: item.date ?? null,
      payers,
      member_ids: item.member_ids?.length ? item.member_ids : undefined,
      members: item.members?.length ? item.members : undefined,
      note: item.note?.trim() || null,
      ticket_json: ticket,
      split_mode: item.split_mode ?? undefined,
    };
    // Freeze the live FX rate for a foreign-currency receipt so a settled position
    // isn't re-opened when live rates drift (#1445).
    await this.budget.freezeForeignRate(tripId, data);
    const budgetItem = this.budget.createBudgetItem(tripId, data);

    if (receiptFileId != null) {
      this.db.prepare('UPDATE budget_items SET receipt_file_id = ? WHERE id = ?').run(receiptFileId, budgetItem.id);
      return { ...budgetItem, receipt_file_id: receiptFileId };
    }
    return budgetItem;
  }

  /** The user's category when it is a real one, else the doc type's. */
  private resolveCategory(item: ReceiptConfirmItem): CostCategory {
    const chosen = (item.category ?? '').trim().toLowerCase();
    if (COST_CATEGORY_SET.has(chosen)) return chosen as CostCategory;
    return receiptDocTypeToCostCategory(item.doc_type);
  }
}
