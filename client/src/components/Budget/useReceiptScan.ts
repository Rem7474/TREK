import { type ReceiptConfirmItem, type ReceiptScanItem, type ReceiptScanResponse, receiptCreatesReservationByDefault } from '@trek/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { receiptsApi } from '../../api/client';
import { addListener, removeListener } from '../../api/websocket';
import { useTranslation } from '../../i18n';
import { useBackgroundTasksStore } from '../../store/backgroundTasksStore';
import { isProviderSafeImage, normalizeReceiptImage } from '../../utils/receiptImage';
import { useToast } from '../shared/Toast';
import type { ExpenseSplitPayload } from './useExpenseSplit';

/**
 * Everything a receipt scan does that is not chrome: pick the files, hand the
 * reading to the background job, keep the reviewed drafts, confirm them.
 *
 * The desktop dialog and the mobile sheet are two renderings of this one flow.
 * They looked alike enough to share a component once, and that is exactly how a
 * desktop panel ended up inside the mobile shell — so the logic lives here and
 * each shell brings only its own furniture.
 */

/** What a document reader can make sense of without ever looking at pixels. */
const TEXT_EXTS = ['.pdf', '.txt', '.html', '.htm', '.eml'];
/** Only worth offering when the configured model can actually see. */
const PHOTO_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 5;

/** A scanned receipt while the user is reviewing it — the confirm payload plus the two receipt choices. */
export interface Draft extends ReceiptScanItem {
  /** Stable across removals, so a card keeps the split its own receipt was given. */
  uid: string;
  create_reservation: boolean;
  attach_receipt: boolean;
}

/** What one card's split editor reports back: the payload, the total it implies, and whether it adds up. */
export interface DraftSplit {
  payload: ExpenseSplitPayload;
  total: number;
  valid: boolean;
}

/** The bits of an axios rejection these handlers read — narrower than `any`, and enough. */
type ApiError = { response?: { status?: number; data?: { error?: string } } };

function toDraft(item: ReceiptScanItem, index: number, base: string, intent: 'expense' | 'booking'): Draft {
  return {
    ...item,
    uid: `${index}-${item.source.fileName}`,
    // A missing date means the scan couldn't read one — default to today rather
    // than filing the expense with no day at all.
    date: item.date || new Date().toISOString().slice(0, 10),
    currency: (item.currency || base).toUpperCase(),
    create_reservation: intent === 'booking' || receiptCreatesReservationByDefault(item.doc_type),
    attach_receipt: true,
  };
}

export function useReceiptScan({
  tripId,
  base,
  intent,
  photos = true,
  initialFiles,
  initialResult,
  onClose,
  onSaved,
  onFilesConsumed,
}: {
  tripId: number;
  base: string;
  intent: 'expense' | 'booking';
  /**
   * Whether the configured model can read a photograph. A text-only one still
   * reads a PDF invoice, so this narrows what is offered rather than closing the
   * scanner: no camera, and no image types in the picker.
   */
  photos?: boolean;
  initialFiles?: File[];
  initialResult?: ReceiptScanResponse;
  onClose: () => void;
  onSaved: () => void;
  /** The upstream picker can let go of its files: the job owns them now. */
  onFilesConsumed?: () => void;
}) {
  const acceptedExts = photos ? [...PHOTO_EXTS, ...TEXT_EXTS] : TEXT_EXTS;
  const { t } = useTranslation();
  const addTask = useBackgroundTasksStore((s) => s.addTask);
  const toast = useToast();

  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<'pick' | 'scanning' | 'review'>('pick');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [splits, setSplits] = useState<Record<string, DraftSplit>>({});
  const [scanId, setScanId] = useState<string | undefined>();
  const [jobId, setJobId] = useState<string | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  /** Validate, shrink and keep what was chosen, wherever the picker came from. */
  const selectFiles = async (incoming: File[]) => {
    const valid: File[] = [];
    let firstErr = '';
    for (const f of incoming.slice(0, MAX_FILES)) {
      const ext = '.' + f.name.toLowerCase().split('.').pop();
      if (!acceptedExts.includes(ext)) {
        firstErr = firstErr || t('receipts.unsupportedFormat');
        continue;
      }
      // Shrink and re-encode before measuring: a phone photo is over the limit at
      // full size and comfortably under it once it is only as large as the model
      // needs — refusing it whole would refuse a receipt TREK can perfectly read.
      const prepared = await normalizeReceiptImage(f);
      // An image the browser could not turn into a JPEG is one no vision provider
      // will read either (an iPhone's HEIC, most often). Saying so now beats a
      // refusal arriving five minutes into the scan.
      if (prepared.type.startsWith('image/') && !isProviderSafeImage(prepared)) {
        firstErr = firstErr || t('receipts.unsupportedFormat');
        continue;
      }
      if (prepared.size > MAX_FILE_BYTES) {
        firstErr = firstErr || t('receipts.fileTooLarge', { name: f.name });
        continue;
      }
      valid.push(prepared);
    }
    setError(firstErr);
    if (valid.length) setFiles(valid);
  };

  // Opened from the shared picker: the user already chose, don't ask twice.
  //
  // Not when a finished scan is being reopened, though: a result means the
  // picking is long over, and feeding the files back in would re-validate and
  // re-encode something that has already been read.
  useEffect(() => {
    if (initialResult) return;
    if (initialFiles?.length) void selectFiles(initialFiles);
    // selectFiles is stable — intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles, initialResult]);

  /** Show whatever the background scan produced, however it reached us. */
  const applyResult = useCallback(
    (res: ReceiptScanResponse) => {
      setScanId(res.scanId);
      // A provider refusal carries a code, so the reader gets it in their own
      // language; the server's English line is the fallback for anything else.
      const translated = (res.files ?? [])
        .filter((f) => f.failureCode)
        .map((f) => `${f.fileName}: ${t(`receipts.failure.${f.failureCode}`)}`);
      setWarnings(translated.length ? translated : res.warnings || []);
      if (!res.items.length) {
        setPhase('pick');
        setError(translated[0] || res.warnings?.[0] || t('receipts.nothingFound'));
        return;
      }
      setDrafts(res.items.map((item, i) => toDraft(item, i, base, intent)));
      setSplits({});
      setPhase('review');
    },
    [t, base, intent]
  );

  // The scan is a background job now, so the result arrives on the user's socket
  // rather than as the upload's response. Poll as a backstop: a push missed during
  // a reconnect would otherwise leave the panel spinning forever.
  useEffect(() => {
    if (!jobId) return;

    const finish = (status: 'done' | 'error', result?: ReceiptScanResponse, message?: string) => {
      setJobId(undefined);
      if (status === 'done' && result) applyResult(result);
      else {
        setPhase('pick');
        setError(message || t('receipts.error'));
      }
    };

    const onEvent = (e: Record<string, unknown>) => {
      const type = typeof e.type === 'string' ? e.type : '';
      if (!type.startsWith('receipt:') || String(e.jobId ?? '') !== jobId) return;
      if (type === 'receipt:done') finish('done', e.result as ReceiptScanResponse);
      else if (type === 'receipt:error') finish('error', undefined, String(e.message ?? ''));
    };
    addListener(onEvent);

    const check = () => {
      receiptsApi
        .scanJobStatus(tripId, jobId)
        .then((s) => {
          if (s.status === 'done') finish('done', s.result);
          else if (s.status === 'error') finish('error', undefined, s.error);
        })
        .catch(() => {});
    };
    // Once straight away — a text receipt can be read before the socket message
    // lands, and waiting out the first interval would show a spinner for nothing.
    check();
    const poll = setInterval(check, 4000);

    return () => {
      removeListener(onEvent);
      clearInterval(poll);
    };
  }, [jobId, tripId, applyResult, t]);

  // Reopened from the widget with a finished scan: skip straight to the review.
  useEffect(() => {
    if (initialResult) applyResult(initialResult);
    // applyResult is stable — intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialResult]);

  const handleScan = async () => {
    if (files.length === 0 || phase === 'scanning') return;
    setPhase('scanning');
    setError('');
    try {
      // The scan runs server-side: reading a photograph on a CPU vision model
      // outlasts proxy timeouts, and the work must survive this modal closing.
      const { jobId } = await receiptsApi.scanAsync(tripId, files);
      // Hand the wait to the background widget and get out of the way: reading a
      // photograph takes minutes, and there is nothing to watch on this screen.
      addTask({
        id: jobId,
        tripId: String(tripId),
        label: files.map((f) => f.name).join(', '),
        total: files.length,
        job: 'receipt',
      });
      onClose();
      onFilesConsumed?.();
      return;
    } catch (err) {
      const failure = err as ApiError;
      setPhase('pick');
      setError(
        failure.response?.status === 409
          ? t('receipts.notConfigured')
          : failure.response?.data?.error || t('receipts.error')
      );
    }
  };

  const patch = (index: number, changes: Partial<Draft>) =>
    setDrafts((list) => list.map((d, i) => (i === index ? { ...d, ...changes } : d)));

  // Each card edits its own split; the parent only keeps the answer to send.
  const setSplit = useCallback(
    (uid: string, next: DraftSplit) => setSplits((prev) => ({ ...prev, [uid]: next })),
    []
  );

  // A split that does not add up is refused here for the same reason the Costs
  // dialog refuses it: the server re-derives the total from the payer sum.
  const splitsOk = drafts.every((d) => splits[d.uid]?.valid !== false);

  const handleSave = async () => {
    if (saving || drafts.length === 0 || !splitsOk) return;
    setSaving(true);
    try {
      const items: ReceiptConfirmItem[] = drafts.map(({ uid, create_reservation, attach_receipt, ...item }) => {
        const split = splits[uid];
        return {
          ...item,
          // In ticket mode the rows are the receipt, so they set the total.
          total: split?.total ?? item.total,
          create_reservation,
          attach_receipt,
          ...(split?.payload ?? {}),
        };
      });
      const res = await receiptsApi.confirm(tripId, scanId, items);
      for (const warning of res.warnings || []) toast.error(warning);
      const count = res.created.length;
      toast.success(count > 1 ? t('receipts.savedPlural', { count }) : t('receipts.saved'));
      onSaved();
    } catch (err) {
      toast.error((err as ApiError).response?.data?.error || t('receipts.saveError'));
      setSaving(false);
    }
  };

  return {
    files,
    phase,
    drafts,
    splits,
    warnings,
    error,
    saving,
    isDragOver,
    setIsDragOver,
    fileInputRef,
    cameraInputRef,
    accept: acceptedExts.join(','),
    photos,
    selectFiles,
    handleScan,
    handleSave,
    patch,
    setSplit,
    removeDraft: (uid: string) => setDrafts((list) => list.filter((d) => d.uid !== uid)),
    splitsOk,
  };
}
