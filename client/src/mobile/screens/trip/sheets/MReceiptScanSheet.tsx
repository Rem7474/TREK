import {
  RECEIPT_DOC_TYPES,
  receiptDocTypeToCostCategory,
  type ReceiptDocType,
  type ReceiptScanResponse,
} from '@trek/shared'
import { AlertCircle, Camera, ScanLine, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { SYMBOLS, currenciesWith } from '../../../../components/Budget/BudgetPanel.constants'
import type { TripMember } from '../../../../components/Budget/BudgetPanelMemberChips'
import { COST_CATEGORY_LIST, catMeta } from '../../../../components/Budget/costsCategories'
import { useExpenseSplit } from '../../../../components/Budget/useExpenseSplit'
import { useReceiptScan, type Draft, type DraftSplit } from '../../../../components/Budget/useReceiptScan'
import CustomSelect from '../../../../components/shared/CustomSelect'
import { CustomDatePicker } from '../../../../components/shared/CustomDateTimePicker'
import { NumericInput } from '../../../../components/shared/NumericInput'
import { useExchangeRates } from '../../../../hooks/useExchangeRates'
import { useTranslation } from '../../../../i18n'
import { formatMoney, localizeAmountInput } from '../../../../utils/formatters'
import MSheet from '../../../components/MSheet'
import MExpenseSplitFields from './MExpenseSplitFields'
import { Eyebrow, FIELD_CLS, FormSheetFooter, FormSheetHeader } from './PlSheetChrome'

/**
 * Scan a receipt — the mobile shell's own sheet.
 *
 * The desktop dialog (ReceiptScanModal) reviews the same scan; both are chrome
 * over useReceiptScan, and both review the split with the same state. What is
 * particular to a phone is the picking: the camera comes first and is a button,
 * not a drop zone, because there is nothing to drop from.
 */
export default function MReceiptScanSheet({
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
  tripId: number
  base: string
  people: TripMember[]
  me: number
  /** Whether the configured model reads photographs; without it, no camera. */
  photosAvailable?: boolean
  initialFiles?: File[]
  initialResult?: ReceiptScanResponse
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()

  // Internal open flag so the exit animation still plays even though the parent
  // unmounts us on close.
  const [open, setOpen] = useState(true)
  const closeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])
  const requestClose = () => {
    setOpen(false)
    closeTimer.current = window.setTimeout(onClose, 280)
  }

  const {
    files, phase, drafts, warnings, error, saving,
    fileInputRef, accept, photos,
    selectFiles, handleScan, handleSave, patch, setSplit, removeDraft, splitsOk,
  } = useReceiptScan({ tripId, base, photos: photosAvailable, initialFiles, initialResult, onClose: requestClose, onSaved })

  const reviewing = phase === 'review'

  return (
    <MSheet
      open={open}
      onClose={requestClose}
      material="opaque"
      ariaLabel={reviewing ? t('receipts.reviewTitle') : t('receipts.title')}
    >
      <FormSheetHeader
        icon={ScanLine}
        title={reviewing ? t('receipts.reviewTitle') : t('receipts.title')}
        onClose={requestClose}
        closeLabel={t('common.close')}
      />


      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-[2px]">
        {!reviewing && (
          <>
            <p className="mt-2 text-[0.78125rem] leading-relaxed text-m-muted">
              {t('receipts.subtitle')}
            </p>

            {/* One button. The OS picker already offers Camera beside Library and
                Files, so a second button for the camera only asked the same
                question twice — and whatever comes back, if it is an image, goes
                through the cropper exactly as a fresh photograph does. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="mt-3 flex w-full items-center justify-center gap-[8px] rounded-[14px] bg-m-act py-[13px] text-[0.84375rem] font-semibold text-m-actfg"
            >
              {photos ? <Camera size={16} strokeWidth={2} /> : <Upload size={16} strokeWidth={2} />}
              {photos ? t('receipts.pickOrPhoto') : t('receipts.dropHere')}
            </button>
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-m-faint">{t('receipts.accepted')}</p>


            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              multiple
              className="hidden"
              onChange={(e) => {
                const list = e.target.files ? Array.from(e.target.files) : []
                if (list.length) void selectFiles(list)
                e.target.value = ''
              }}
            />

            {files.length > 0 && (
              <div className="mt-3 flex flex-col gap-[6px]">
                {files.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center gap-[9px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px]"
                  >
                    <ScanLine size={15} strokeWidth={2} className="flex-none text-m-muted" />
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-m-ink">{f.name}</span>
                  </div>
                ))}
              </div>
            )}

            {error && (
              <p className="mt-3 text-[0.71875rem] font-medium text-[color:var(--m-st-danger)]">{error}</p>
            )}
          </>
        )}

        {reviewing && (
          <>
            <p className="mt-2 text-[0.78125rem] text-m-muted">
              {t('receipts.reviewSubtitle', { count: drafts.length })}
            </p>
            {warnings.map((w, i) => (
              <p key={i} className="mt-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-2 text-[0.6875rem] text-m-muted">
                {w}
              </p>
            ))}
            {drafts.map((draft, index) => (
              <MReceiptDraftCard
                key={draft.uid}
                draft={draft}
                base={base}
                people={people}
                me={me}
                removable={drafts.length > 1}
                patch={(changes) => patch(index, changes)}
                onRemove={() => removeDraft(draft.uid)}
                onSplitChange={setSplit}
              />
            ))}
          </>
        )}
      </div>

      <FormSheetFooter
        onCancel={requestClose}
        cancelLabel={reviewing ? t('receipts.discard') : t('common.cancel')}
        onSubmit={reviewing ? handleSave : handleScan}
        submitLabel={
          reviewing
            ? drafts.length > 1
              ? t('receipts.savePlural', { count: drafts.length })
              : t('receipts.save')
            : t('receipts.scanAction')
        }
        submitDisabled={reviewing ? saving || !splitsOk : files.length === 0 || phase === 'scanning'}
      />
    </MSheet>
  )
}

/** One scanned receipt under review, in the sheet's own chrome. */
function MReceiptDraftCard({
  draft, base, people, me, removable, patch, onRemove, onSplitChange,
}: {
  draft: Draft
  base: string
  people: TripMember[]
  me: number
  removable: boolean
  patch: (changes: Partial<Draft>) => void
  onRemove: () => void
  onSplitChange: (uid: string, split: DraftSplit) => void
}) {
  const { t, locale } = useTranslation()
  const { convert } = useExchangeRates(base)
  const split = useExpenseSplit({ people, me, seedLines: draft.line_items, total: draft.total, currency: draft.currency })

  const sym = (c: string) => SYMBOLS[c] || c + ' '
  const cat = catMeta(draft.category)
  const CatIcon = cat.Icon
  const currency = (draft.currency || base).toUpperCase()

  const docTypeOptions = useMemo(
    () => RECEIPT_DOC_TYPES.map((type) => ({ value: type, label: t(`receipts.type.${type}`) })),
    [t],
  )

  // Report the split up on every change. Serialising it is what settles the
  // effect: buildPayload returns a fresh object each render.
  const payload = split.buildPayload()
  const total = split.totalNum
  const valid = split.splitValid
  const signature = JSON.stringify(payload) + '|' + total + '|' + valid
  useEffect(() => {
    onSplitChange(draft.uid, { payload, total, valid })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, draft.uid])

  const itinerary = (
    <div className="mt-3 flex flex-col gap-[6px]">
      <label className="flex items-center gap-[10px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[10px]">
        <input
          type="checkbox"
          checked={draft.attach_receipt}
          onChange={(e) => patch({ attach_receipt: e.target.checked })}
          className="flex-none"
        />
        <span className="text-[0.8125rem] font-medium text-m-ink">{t('receipts.attachReceipt')}</span>
      </label>
    </div>
  )

  const money = (
    <>
      <Eyebrow className="mb-[5px] mt-3 uppercase">{t('costs.totalAmount')}</Eyebrow>
      <div className={`flex items-center gap-1 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[10px] ${split.isTicketMode ? 'opacity-60' : ''}`}>
        <span className="text-[0.84375rem] font-medium text-m-faint">{sym(currency)}</span>
        <NumericInput
          mode="decimal"
          aria-label={t('costs.totalAmount')}
          value={split.isTicketMode ? split.totalNum.toFixed(2) : localizeAmountInput(String(draft.total), currency)}
          disabled={split.isTicketMode}
          onValueChange={(v) => patch({ total: parseFloat(v.replace(',', '.')) || 0 })}
          className="min-w-0 flex-1 border-0 bg-transparent text-[0.84375rem] font-semibold text-m-ink outline-none [font-variant-numeric:tabular-nums]"
        />
      </div>

      <div className="mt-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <Eyebrow className="mb-[5px] uppercase">{t('costs.currency')}</Eyebrow>
          <CustomSelect
            value={currency}
            onChange={(v) => patch({ currency: String(v) })}
            searchable
            size="sm"
            options={currenciesWith(currency).map((c) => ({ value: c, label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c }))}
            style={{ width: '100%' }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Eyebrow className="mb-[5px] uppercase">{t('costs.day')}</Eyebrow>
          <CustomDatePicker value={draft.date || ''} onChange={(d: string) => patch({ date: d })} style={{ width: '100%' }} />
        </div>
      </div>

      {currency !== base && split.totalNum > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px] text-[0.71875rem] text-m-muted">
          <span>{formatMoney(split.totalNum, currency, locale)}</span>
          <span className="text-m-faint">≈</span>
          <span className="font-semibold text-m-ink">{formatMoney(convert(split.totalNum, currency), base, locale)}</span>
        </div>
      )}
    </>
  )

  return (
    <div className="mt-3 rounded-[16px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] p-3">
      <div className="flex items-center gap-[8px]">
        <span
          className="grid flex-none place-items-center rounded-[8px]"
          style={{ width: 26, height: 26, background: cat.color + '22', color: cat.color }}
        >
          <CatIcon size={14} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-m-ink">{draft.source.fileName}</span>
        {draft.needs_review && (
          <span className="flex flex-none items-center gap-1 text-[0.6875rem] font-semibold text-[color:var(--m-st-pending)]">
            <AlertCircle size={13} /> {t('receipts.needsReview')}
          </span>
        )}
        {removable && (
          <button type="button" onClick={onRemove} aria-label={t('common.delete')} className="flex-none text-m-faint">
            <X size={15} strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <Eyebrow className="mb-[5px] uppercase">{t('receipts.docType')}</Eyebrow>
          <CustomSelect
            value={draft.doc_type}
            options={docTypeOptions}
            size="sm"
            style={{ width: '100%' }}
            onChange={(v) => {
              const docType = String(v) as ReceiptDocType
              patch({
                doc_type: docType,
                category: receiptDocTypeToCostCategory(docType),
              })
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Eyebrow className="mb-[5px] uppercase">{t('costs.category')}</Eyebrow>
          <CustomSelect
            value={cat.key}
            size="sm"
            style={{ width: '100%' }}
            options={COST_CATEGORY_LIST.map((c) => ({ value: c.key, label: t(c.labelKey) }))}
            onChange={(v) => patch({ category: String(v) })}
          />
        </div>
      </div>

      <Eyebrow className="mb-[5px] mt-3 uppercase">{t('receipts.merchant')}</Eyebrow>
      <input type="text" value={draft.title} onChange={(e) => patch({ title: e.target.value })} className={FIELD_CLS} />

      {money}
      {itinerary}

      <MExpenseSplitFields split={split} people={people} me={me} currency={currency} />

      {draft.line_items && draft.line_items.length > 0 && (
        <p className="mt-2 text-[0.6875rem] text-m-faint">{t('receipts.lineItems', { count: draft.line_items.length })}</p>
      )}
    </div>
  )
}
