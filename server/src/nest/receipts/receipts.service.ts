import type { User } from '../../types';
import { BudgetService } from '../budget/budget.service';
import { DatabaseService, type TripAccess } from '../database/database.service';
import { filesDir } from '../files/files.constants';
import { FilesService } from '../files/files.service';
import { LlmParseService } from '../llm-parse/llm-parse.service';
import { MapsService } from '../maps/maps.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PlacesService } from '../places/places.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReservationsService } from '../reservations/reservations.service';
import { mapReceipts, reservationTypeForItem, toLocalDateTime } from './receipt-mapper';
import { ReceiptScanStore, type StoredReceiptFile } from './receipt-scan.store';
import { HttpException, Injectable } from '@nestjs/common';
import {
  receiptCreatesReservationByDefault,
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
 * amount → the confirmed result becomes an expense, and, when the document
 * describes a stay or a journey, the matching reservation, place and trip
 * document too.
 *
 * The extraction reuses the booking import's provider plumbing (LlmParseService)
 * with a receipt-specific prompt and schema; the persistence reuses the existing
 * budget/reservation/place/file services, so a scanned expense is indistinguishable
 * from a hand-entered one.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly llmParse: LlmParseService,
    private readonly store: ReceiptScanStore,
    private readonly dbs: DatabaseService,
    private readonly budget: BudgetService,
    private readonly files: FilesService,
    private readonly maps: MapsService,
    private readonly permissions: PermissionsService,
    private readonly places: PlacesService,
    private readonly realtime: RealtimeService,
    private readonly reservations: ReservationsService,
  ) {}

  private get db() {
    return this.dbs.connection;
  }

  /**
   * Trip day whose date matches an ISO timestamp, clamped to the nearest day when
   * the date falls outside the trip, so an out-of-range check-in still resolves
   * and the accommodation row is inserted. Mirrors the reservation import.
   */
  private resolveDayId(tripId: string, iso: string | null | undefined): number | null {
    if (!iso) return null;
    const date = iso.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const exact = this.db.prepare('SELECT id FROM days WHERE trip_id = ? AND date = ? LIMIT 1').get(tripId, date) as { id: number } | undefined;
    if (exact) return exact.id;
    const nearest = this.db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY ABS(JULIANDAY(date) - JULIANDAY(?)) ASC, date ASC LIMIT 1').get(tripId, date) as { id: number } | undefined;
    return nearest?.id ?? null;
  }

  /** Receipts are read by a vision/text model — there is no non-AI fallback. */
  isAvailable(userId: number): boolean {
    return this.llmParse.isAvailable(userId);
  }

  /**
   * Whether the caller may also create the booking a receipt describes. Trip
   * access and 'budget_edit' are settled by the controller's guard chain; this is
   * the extra right, and lacking it degrades the result rather than rejecting it.
   */
  canEditReservations(trip: TripAccess, user: User): boolean {
    return this.permissions.checkPermission('reservation_edit', user.role, trip.user_id, user.id, trip.user_id !== user.id);
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
   * Persist the reviewed receipts. Per item, in order: the place and reservation
   * (when asked for and the doc type has one), the receipt document, then the
   * expense that links them together. A failure on one item is logged and the
   * rest still go through — same tolerance as the booking import's confirm.
   */
  async confirm(
    tripId: string,
    user: User,
    scanId: string | undefined,
    items: ReceiptConfirmItem[],
    canCreateReservations: boolean,
    socketId: string | undefined,
  ): Promise<ReceiptConfirmResponse> {
    const created: ReceiptConfirmResult[] = [];
    const warnings: string[] = [];

    for (const item of items) {
      try {
        const wantsReservation = item.create_reservation ?? receiptCreatesReservationByDefault(item.doc_type);
        let reservation: Record<string, unknown> | null = null;

        if (wantsReservation) {
          if (canCreateReservations) {
            reservation = await this.createReservationFor(tripId, item, socketId);
          } else {
            warnings.push(`${item.title}: expense created without a booking (no reservation permission)`);
          }
        }

        const reservationId = reservation ? (reservation.id as number) : undefined;
        // Whoever the bill is split between was at the table. Leaving the booking
        // empty made the reviewer tick the same names twice, on two screens, for
        // one meal — and the expense has already been asked the question.
        if (reservationId != null) {
          const diners = item.member_ids?.length
            ? item.member_ids
            : (item.payers ?? []).filter((p) => p.amount > 0).map((p) => p.user_id);
          if (diners.length > 0) this.reservations.setReservationTravelers(reservationId, tripId, diners);
        }
        const file = this.attachReceipt(tripId, user.id, scanId, item, reservationId, socketId);
        // The bytes are held only for the length of the review. Someone who left
        // the scan sitting in the tray for half an hour still gets the expense —
        // they should just be told the image did not come with it.
        if (!file && item.attach_receipt !== false && scanId) {
          warnings.push(`${item.title}: the receipt image was no longer available`);
        }

        const budgetItem = await this.createExpense(tripId, user, item, reservationId, file?.id);
        this.realtime.broadcast(tripId, 'budget:created', { item: budgetItem }, socketId);

        created.push({ budget_item: budgetItem as Record<string, unknown>, reservation, file });
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
   * Build the itinerary entry a receipt documents: a place (geocoded from the
   * merchant address) for venue-based types, endpoints for a journey, and the
   * accommodation row for a hotel folio.
   */
  private async createReservationFor(
    tripId: string,
    item: ReceiptConfirmItem,
    socketId: string | undefined,
  ): Promise<Record<string, unknown> | null> {
    const type = reservationTypeForItem(item);
    if (!type) return null;

    const isVenue = type === 'hotel' || type === 'restaurant' || type === 'event';
    let placeId: number | undefined;
    if (isVenue && item.merchant) {
      const coords = await this.geocode([
        item.address ? `${item.merchant} ${item.address}` : null,
        item.address,
        item.merchant,
      ]);
      const place = this.places.create(tripId, {
        name: item.merchant,
        address: item.address ?? undefined,
        lat: coords?.lat,
        lng: coords?.lng,
      });
      placeId = (place as { id: number }).id;
      this.realtime.broadcast(tripId, 'place:created', { place }, socketId);
    }

    // A journey's From→To only persists with coordinates; an ungeocodable stop
    // still shows in the title, so a missing hit is not fatal.
    const endpoints: { role: 'from' | 'to'; sequence: number; name: string; lat: number; lng: number }[] = [];
    if (!isVenue) {
      const legs: ['from' | 'to', string | null | undefined][] = [
        ['from', item.from],
        ['to', item.to],
      ];
      for (const [role, name] of legs) {
        if (!name) continue;
        const coords = await this.geocode([name]);
        if (coords) endpoints.push({ role, sequence: role === 'from' ? 0 : 1, name, lat: coords.lat, lng: coords.lng });
      }
    }

    // On a till receipt the printed time is the moment of PAYMENT, so for a meal
    // it is when the table was left, not when it was taken. Recording it as the
    // start put the restaurant on the timeline at the hour the bill was settled.
    // The start is simply not on the paper, and it is not invented here: the day
    // is set outright so the booking still lands where it belongs.
    const paidAt = toLocalDateTime(item.date ?? null, item.time ?? null);
    const paidOnly = type === 'restaurant' && !item.departure_time && !item.check_in;
    const start = paidOnly ? null : (item.departure_time ?? item.check_in ?? paidAt);
    const end = item.arrival_time ?? item.check_out ?? (paidOnly ? paidAt : null);

    let createAccommodation:
      | {
          place_id?: number;
          start_day_id?: number;
          end_day_id?: number;
          check_in?: string;
          check_out?: string;
          confirmation?: string;
        }
      | undefined;
    if (type === 'hotel') {
      const checkIn = item.check_in ?? item.date ?? null;
      const checkOut = item.check_out ?? null;
      const startDayId = this.resolveDayId(tripId, checkIn);
      const endDayId = this.resolveDayId(tripId, checkOut ?? checkIn);
      createAccommodation = {
        place_id: placeId,
        start_day_id: startDayId ?? undefined,
        end_day_id: endDayId ?? undefined,
        check_in: checkIn ?? undefined,
        check_out: checkOut ?? undefined,
        confirmation: item.confirmation_number ?? undefined,
      };
    }

    const { reservation, accommodationCreated } = this.reservations.create(tripId, {
      title: this.reservationTitle(item, type),
      type,
      // The receipt is proof it happened — nothing left to confirm.
      status: 'confirmed',
      reservation_time: start ?? undefined,
      reservation_end_time: end ?? undefined,
      // Without a start there is nothing for the planner to place the meal by.
      ...(paidOnly ? { day_id: this.resolveDayId(tripId, item.date ?? null) ?? undefined } : {}),
      location: item.address ?? item.from ?? undefined,
      confirmation_number: item.confirmation_number ?? undefined,
      place_id: placeId,
      metadata: {
        price: String(item.total),
        ...(item.currency ? { priceCurrency: item.currency } : {}),
        ...(item.carrier ? { carrier: item.carrier } : {}),
        ...(item.travel_number ? { travel_number: item.travel_number } : {}),
        source: 'receipt-scan',
      },
      endpoints: endpoints.length > 0 ? endpoints : undefined,
      needs_review: item.needs_review === true,
      create_accommodation: createAccommodation,
    } as Parameters<ReservationsService['create']>[1]);

    this.realtime.broadcast(tripId, 'reservation:created', { reservation }, socketId);
    if (accommodationCreated) this.realtime.broadcast(tripId, 'accommodation:created', {}, socketId);

    return reservation as Record<string, unknown>;
  }

  /** "Paris → Lyon" for a journey, the merchant otherwise. */
  private reservationTitle(item: ReceiptConfirmItem, type: string): string {
    if (type !== 'hotel' && type !== 'restaurant' && type !== 'event' && item.from && item.to) {
      return `${item.from} → ${item.to}`;
    }
    return item.title;
  }

  /** First Nominatim hit for the first query that returns one. */
  private async geocode(queries: (string | null | undefined)[]): Promise<{ lat: number; lng: number } | null> {
    for (const query of queries) {
      if (!query) continue;
      try {
        const hit = (await this.maps.searchNominatim(query))[0];
        if (hit?.lat != null && hit?.lng != null) return { lat: hit.lat, lng: hit.lng };
      } catch {
        // geocoding failure is non-fatal — the entry is still worth creating
      }
    }
    return null;
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
    reservationId: number | undefined,
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
        {
          reservation_id: reservationId != null ? String(reservationId) : null,
          description: `Receipt — ${item.title}`,
        },
      );
      const document = file as Record<string, unknown> & { id: number };
      if (reservationId != null) this.files.createFileLink(document.id, { reservation_id: String(reservationId) });
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
    reservationId: number | undefined,
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
      reservation_id: reservationId ?? null,
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
