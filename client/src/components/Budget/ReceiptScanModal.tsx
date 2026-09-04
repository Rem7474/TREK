import {
  RECEIPT_DOC_TYPES,
  receiptDocTypeToCostCategory,
  type ReceiptDocType,
  type ReceiptScanResponse,
} from '@trek/shared';
import { AlertCircle, Camera, Loader2, Upload, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useExchangeRates } from '../../hooks/useExchangeRates';
import { useTranslation } from '../../i18n';
import { formatMoney } from '../../utils/formatters';
import { CustomDatePicker } from '../shared/CustomDateTimePicker';
import CustomSelect from '../shared/CustomSelect';
import Modal from '../shared/Modal';
import { NumericInput } from '../shared/NumericInput';
import { SYMBOLS, currenciesWith } from './BudgetPanel.constants';
import type { TripMember } from './BudgetPanelMemberChips';
import { ExpenseNotePanel, ExpensePayerPanel, ExpenseSplitPanel } from './ExpenseSplitEditor';
import { useExpenseSplit } from './useExpenseSplit';
import { useReceiptScan, type Draft, type DraftSplit } from './useReceiptScan';
import { COST_CATEGORY_LIST, catMeta } from './costsCategories';

const LABEL_CLS =
  'block mb-1.5 text-[calc(11.5px*var(--fs-scale-caption,1))] font-semibold uppercase tracking-wide text-content-faint';
const INPUT_CLS =
  'w-full bg-surface-input border border-edge rounded-[10px] px-3 py-2 text-[calc(14px*var(--fs-scale-body,1))] text-content outline-none';

/**
 * Scan a receipt into an expense: upload/photograph → the server classifies it and
 * reads the amount → the user checks the result → save.
 *
 * The review step is deliberately a light editor, not a second expense form: it
 * fixes what an OCR pass gets wrong (type, merchant, amount, date) and offers the
 * two decisions only a receipt raises — whether the document also belongs on the
 * itinerary, and whether to keep the image in Documents. Anything finer (custom
 * splits, several payers) is one click away in the expense itself afterwards.
 */

export default function ReceiptScanModal({
  tripId,
  base,
  people,
  me,
  photosAvailable = true,
  initialFiles,
  initialResult,
  onClose,
  onSaved,
}: {
  tripId: number;
  base: string;
  people: TripMember[];
  me: number;
  /**
   * Which screen opened this. 'expense' (Costs) reviews the money first;
   * 'booking' (Transport/Reservations) reviews the itinerary entry first and
   * ticks it by default, because that is what the user came to create.
   */
  /** Whether the configured model reads photographs; without it, no camera. */
  photosAvailable?: boolean;
  /** Files already chosen upstream — the shared picker hands them straight over. */
  initialFiles?: File[];
  /**
   * A scan that already finished in the background. Reopening from the tasks
   * widget lands straight on the review, because the reading is the slow part
   * and the user has already waited for it once.
   */
  initialResult?: ReceiptScanResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();

  // The flow itself lives in useReceiptScan; this file is the desktop chrome
  // around it, and MReceiptScanSheet is the mobile one.
  const {
    files,
    phase,
    drafts,
    warnings,
    error,
    saving,
    isDragOver,
    setIsDragOver,
    fileInputRef,
    cameraInputRef,
    accept,
    photos,
    selectFiles,
    handleScan,
    handleSave,
    patch,
    setSplit,
    removeDraft,
    splitsOk,
  } = useReceiptScan({ tripId, base, photos: photosAvailable, initialFiles, initialResult, onClose, onSaved });

  const footer =
    phase === 'review' ? (
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button"
          onClick={onClose}
          disabled={saving}
          className="border border-edge text-content disabled:opacity-50"
          style={{
            padding: '8px 16px',
            borderRadius: 10,
            background: 'none',
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('receipts.discard')}
        </button>
        <button type="button"
          onClick={handleSave}
          disabled={saving || !splitsOk}
          className="bg-[var(--text-primary)] text-[var(--bg-primary)] disabled:opacity-50"
          style={{
            padding: '8px 16px',
            borderRadius: 10,
            border: 0,
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {drafts.length > 1 ? t('receipts.savePlural', { count: drafts.length }) : t('receipts.save')}
        </button>
      </div>
    ) : (
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button"
          onClick={onClose}
          className="border border-edge text-content"
          style={{
            padding: '8px 16px',
            borderRadius: 10,
            background: 'none',
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('common.cancel')}
        </button>
        <button type="button"
          onClick={handleScan}
          disabled={files.length === 0 || phase === 'scanning'}
          className={
            files.length > 0 && phase !== 'scanning'
              ? 'bg-[var(--text-primary)] text-[var(--bg-primary)]'
              : 'bg-surface-tertiary text-content-faint'
          }
          style={{
            padding: '8px 16px',
            borderRadius: 10,
            border: 0,
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontWeight: 600,
            cursor: files.length ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          {t('receipts.scanAction')}
        </button>
      </div>
    );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={
        phase === 'review'
          ? t('receipts.reviewTitle')
          : t('receipts.title')
      }
      size="xl"
      footer={footer}
    >
      {phase !== 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p
            className="text-content-muted"
            style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', lineHeight: 1.5, margin: 0 }}
          >
            {t('receipts.subtitle')}
          </p>

          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (list.length) void selectFiles(list);
            }}
          />
          {/* `capture` opens the camera straight away on a phone — the primary way a receipt gets in. */}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => {
              const list = e.target.files ? Array.from(e.target.files) : [];
              e.target.value = '';
              if (list.length) void selectFiles(list);
            }}
          />

          <div
            onClick={() => phase === 'pick' && fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.target === e.currentTarget) setIsDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              const list = Array.from(e.dataTransfer.files);
              if (list.length) void selectFiles(list);
            }}
            className={isDragOver ? 'bg-surface-tertiary' : 'bg-transparent'}
            style={{
              minHeight: 130,
              borderRadius: 12,
              border: `2px dashed ${isDragOver ? 'var(--accent)' : 'var(--border-primary)'}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: 18,
              cursor: phase === 'pick' ? 'pointer' : 'default',
              textAlign: 'center',
            }}
          >
            {phase === 'scanning' ? (
              <>
                <Loader2 size={20} className="animate-spin" color="var(--text-faint)" />
                <span
                  className="text-content"
                  style={{ fontSize: 'calc(13.5px * var(--fs-scale-body, 1))', fontWeight: 600 }}
                >
                  {t('receipts.scanning')}
                </span>
                <span className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-caption, 1))' }}>
                  {t('receipts.scanningHint')}
                </span>
              </>
            ) : (
              <>
                <Upload
                  size={20}
                  strokeWidth={1.8}
                  color={isDragOver ? 'var(--accent)' : 'var(--text-faint)'}
                  style={{ pointerEvents: 'none' }}
                />
                <span
                  className={files.length ? 'text-content' : 'text-content-faint'}
                  style={{
                    fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                    fontWeight: 500,
                    wordBreak: 'break-all',
                    pointerEvents: 'none',
                  }}
                >
                  {isDragOver
                    ? t('receipts.dropActive')
                    : files.length
                      ? files.map((f) => f.name).join(', ')
                      : t('receipts.dropHere')}
                </span>
                <span
                  className="text-content-faint"
                  style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', pointerEvents: 'none' }}
                >
                  {t('receipts.accepted')}
                </span>
              </>
            )}
          </div>


          {/* No camera when the model cannot see: offering it would spend minutes
              reaching a refusal. The scanner still reads a PDF invoice. */}
          {phase === 'pick' && photos && (
            <button type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="border border-edge bg-surface-secondary text-content"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '10px 14px',
                borderRadius: 10,
                fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Camera size={16} /> {t('receipts.takePhoto')}
            </button>
          )}

          {error && (
            <div
              className="bg-[rgba(239,68,68,0.08)] text-[#b91c1c]"
              style={{
                border: '1px solid rgba(239,68,68,0.35)',
                borderRadius: 10,
                padding: '8px 10px',
                fontSize: 'calc(12px * var(--fs-scale-body, 1))',
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}

      {phase === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p className="text-content-muted" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', margin: 0 }}>
            {t('receipts.reviewSubtitle', { count: drafts.length })}
          </p>

          {warnings.map((w, i) => (
            <div
              key={i}
              className="border border-edge bg-surface-secondary text-content-muted"
              style={{ borderRadius: 10, padding: '8px 10px', fontSize: 'calc(12px * var(--fs-scale-caption, 1))' }}
            >
              {w}
            </div>
          ))}

          {drafts.map((draft, index) => (
            <ReceiptDraftCard
              key={draft.uid}
              draft={draft}
              index={index}
              base={base}
              people={people}
              me={me}
              removable={drafts.length > 1}
              patch={(changes) => patch(index, changes)}
              onRemove={() => removeDraft(draft.uid)}
              onSplitChange={setSplit}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

/**
 * One scanned receipt under review.
 *
 * The money side is the Costs dialog's own editor rather than a reduced copy of
 * it: a scan fills the fields in, it does not take any away, so a receipt can be
 * split by item or fronted by two people exactly as a typed expense can. On top
 * of it sit the two questions only a receipt raises — whether the document also
 * belongs on the itinerary, and whether to keep the image in Documents.
 */
function ReceiptDraftCard({
  draft,
  index,
  base,
  people,
  me,
  removable,
  patch,
  onRemove,
  onSplitChange,
}: {
  draft: Draft;
  index: number;
  base: string;
  people: TripMember[];
  me: number;
  removable: boolean;
  patch: (changes: Partial<Draft>) => void;
  onRemove: () => void;
  onSplitChange: (uid: string, split: DraftSplit) => void;
}) {
  const { t, locale } = useTranslation();
  const { convert } = useExchangeRates(base);
  const split = useExpenseSplit({ people, me, seedLines: draft.line_items, total: draft.total, currency: draft.currency });

  const sym = (c: string) => SYMBOLS[c] || c + ' ';
  const docTypeOptions = useMemo(
    () => RECEIPT_DOC_TYPES.map((type) => ({ value: type, label: t(`receipts.type.${type}`) })),
    [t]
  );

  // Report the split up on every change. Serialising it is what settles the
  // effect: buildPayload returns a fresh object each render, so the payload
  // itself could never be a dependency.
  const payload = split.buildPayload();
  const total = split.totalNum;
  const valid = split.splitValid;
  const signature = JSON.stringify(payload) + '|' + total + '|' + valid;
  useEffect(() => {
    onSplitChange(draft.uid, { payload, total, valid });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, draft.uid]);

  const cat = catMeta(draft.category);
  const CatIcon = cat.Icon;
  const currency = (draft.currency || base).toUpperCase();
  return (
    <div
      className="border border-edge bg-surface-card"
      style={{ borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            background: cat.color + '22',
            color: cat.color,
            flexShrink: 0,
          }}
        >
          <CatIcon size={14} />
        </span>
        <span
          className="text-content"
          style={{
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {draft.source.fileName}
        </span>
        {draft.needs_review && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: '#d97706',
              fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))',
              fontWeight: 600,
            }}
          >
            <AlertCircle size={13} /> {t('receipts.needsReview')}
          </span>
        )}
        {removable && (
          <button type="button"
            onClick={onRemove}
            aria-label={t('common.delete')}
            className="text-content-faint"
            style={{ background: 'none', border: 0, cursor: 'pointer', padding: 2, display: 'flex' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <label className={LABEL_CLS}>{t('receipts.docType')}</label>
          <CustomSelect
            value={draft.doc_type}
            options={docTypeOptions}
            style={{ width: '100%' }}
            onChange={(v) => {
              const docType = String(v) as ReceiptDocType;
              patch({
                doc_type: docType,
                category: receiptDocTypeToCostCategory(docType),
              });
            }}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <label className={LABEL_CLS}>{t('costs.category')}</label>
          <CustomSelect
            value={cat.key}
            style={{ width: '100%' }}
            options={COST_CATEGORY_LIST.map((c) => ({ value: c.key, label: t(c.labelKey) }))}
            onChange={(v) => patch({ category: String(v) })}
          />
        </div>
      </div>

      <div>
        <label className={LABEL_CLS}>{t('receipts.merchant')}</label>
        <input
          className={INPUT_CLS}
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.2fr', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <label className={LABEL_CLS}>{t('costs.totalAmount')}</label>
          <div
            className="border border-edge bg-surface-input"
            style={{ display: 'flex', alignItems: 'center', borderRadius: 10, padding: '0 10px', height: 38 }}
          >
            <span className="text-content-faint" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))' }}>
              {sym(currency)}
            </span>
            <NumericInput
              mode="decimal"
              value={split.isTicketMode ? split.totalNum.toFixed(2) : String(draft.total)}
              disabled={split.isTicketMode}
              aria-label={t('costs.totalAmount')}
              onValueChange={(v) => patch({ total: parseFloat(v.replace(',', '.')) || 0 })}
              className="text-content"
              style={{
                flex: 1,
                border: 0,
                background: 'none',
                outline: 'none',
                fontSize: 'calc(14px * var(--fs-scale-body, 1))',
                fontWeight: 600,
                paddingLeft: 6,
                width: '100%',
              }}
            />
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <label className={LABEL_CLS}>{t('costs.currency')}</label>
          <CustomSelect
            value={currency}
            searchable
            style={{ width: '100%' }}
            options={currenciesWith(currency).map((c) => ({
              value: c,
              label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c,
            }))}
            onChange={(v) => patch({ currency: String(v) })}
          />
        </div>
        <div style={{ minWidth: 0 }}>
          <label className={LABEL_CLS}>{t('costs.day')}</label>
          <CustomDatePicker
            value={draft.date || ''}
            onChange={(d: string) => patch({ date: d })}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {currency !== base && split.totalNum > 0 && (
        <div
          className="border border-edge bg-surface-secondary text-content-muted"
          style={{
            borderRadius: 10,
            padding: '8px 10px',
            fontSize: 'calc(12px * var(--fs-scale-caption, 1))',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span>{formatMoney(split.totalNum, currency, locale)}</span>
          <span className="text-content-faint">≈</span>
          <span className="text-content" style={{ fontWeight: 600 }}>
            {formatMoney(convert(split.totalNum, currency), base, locale)}
          </span>
        </div>
      )}

      <ExpensePayerPanel split={split} people={people} me={me} currency={currency} labelCls={LABEL_CLS} />
      <ExpenseSplitPanel split={split} people={people} me={me} currency={currency} labelCls={LABEL_CLS} />
      <ExpenseNotePanel split={split} labelCls={LABEL_CLS} inputCls={INPUT_CLS} id={`receipt-note-${index}`} />

      <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={draft.attach_receipt}
          onChange={(e) => patch({ attach_receipt: e.target.checked })}
        />
        <span className="text-content" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 500 }}>
          {t('receipts.attachReceipt')}
        </span>
      </label>

      {draft.line_items && draft.line_items.length > 0 && (
        <div className="text-content-faint" style={{ fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))' }}>
          {t('receipts.lineItems', { count: draft.line_items.length })}
        </div>
      )}
    </div>
  );
}
