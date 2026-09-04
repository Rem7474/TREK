import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Wallet } from 'lucide-react'
import MSheet from '../../../components/MSheet'
import CustomSelect from '../../../../components/shared/CustomSelect'
import { CustomDatePicker } from '../../../../components/shared/CustomDateTimePicker'
import { NumericInput } from '../../../../components/shared/NumericInput'
import { Eyebrow, FIELD_CLS, FormSheetFooter, FormSheetHeader } from './PlSheetChrome'
import MExpenseSplitFields from './MExpenseSplitFields'
import { useExpenseSplit } from '../../../../components/Budget/useExpenseSplit'
import { useTranslation } from '../../../../i18n'
import { useToast } from '../../../../components/shared/Toast'
import { useTripStore } from '../../../../store/tripStore'
import { useExchangeRates } from '../../../../hooks/useExchangeRates'
import { formatMoney, localizeAmountInput, amountToInputString } from '../../../../utils/formatters'
import { SYMBOLS, currenciesWith } from '../../../../components/Budget/BudgetPanel.constants'
import { COST_CATEGORY_LIST, catMeta } from '../../../../components/Budget/costsCategories'
import { localToday } from '../../../../components/Planner/today'
import type { ExpensePrefill } from '../../../../components/Budget/CostsPanel'
import type { TripMember } from '../../../../components/Budget/BudgetPanelMemberChips'
import type { BudgetItem } from '../../../../types'

export interface MCostSheetProps {
  tripId: number
  base: string
  people: TripMember[]
  me: number
  editing: BudgetItem | null
  prefill?: ExpensePrefill
  onClose: () => void
  onSaved: () => void
}

/**
 * Add/edit expense sheet — the mobile counterpart of the desktop ExpenseModal
 * (CostsPanel). Drop-in with the same props: the parent mounts it only while
 * open, and it saves through the same tripStore actions (addBudgetItem /
 * updateBudgetItem / deleteBudgetItem). Ports every field and split mode:
 * multi-currency with live conversion, single/multi payer, and the Equally /
 * Custom / Ticket splits.
 */
export default function MCostSheet({ tripId, base, people, me, editing, prefill, onClose, onSaved }: MCostSheetProps) {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const { addBudgetItem, updateBudgetItem, deleteBudgetItem } = useTripStore()
  const { convert } = useExchangeRates(base)
  const sym = (c: string) => SYMBOLS[c] || (c + ' ')

  // Internal open flag so the exit animation still plays even though the parent
  // unmounts us on close.
  const [open, setOpen] = useState(true)
  const closeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])
  const requestClose = () => {
    setOpen(false)
    closeTimer.current = window.setTimeout(onClose, 280)
  }

  const [name, setName] = useState(editing?.name || prefill?.name || '')
  const [cat, setCat] = useState<string>(editing ? catMeta(editing.category).key : (prefill?.category || 'food'))
  const [catOpen, setCatOpen] = useState(false)
  const [currency, setCurrency] = useState((editing?.currency || base).toUpperCase())
  const [day, setDay] = useState(editing?.expense_date || localToday())
  // Edit and prefill seeds are padded to the currency's decimals (#2175), same
  // as the desktop modal: a saved 4,90 must reopen as "4,90", not "4,9". A
  // prefill has no currency of its own and is read as `base`.
  const [total, setTotal] = useState<string>(() => {
    if (editing) return editing.total_price ? amountToInputString(editing.total_price, (editing.currency || base).toUpperCase()) : ''
    if (prefill?.amount != null) return amountToInputString(prefill.amount, base)
    return ''
  })
  // Who paid, how it is shared and the note are the desktop dialog's state,
  // rendered here in the shell's own chrome (MExpenseSplitFields).
  const split = useExpenseSplit({ people, me, editing, total: parseFloat(total) || 0, currency })

  const [saving, setSaving] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)

  const { isTicketMode, ticketInfo, totalNum } = split
  const valid = name.trim().length > 0 && split.splitValid && (isTicketMode || totalNum !== 0)

  const onTotalChange = (v: string) => setTotal(v.replace(',', '.'))

  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    const data = {
      name: name.trim(),
      category: cat,
      currency,
      ...split.buildPayload(),
      expense_date: day || null,
      total_price: totalNum,
      ...(!editing && prefill?.reservationId ? { reservation_id: prefill.reservationId } : {}),
      ...(!editing && prefill?.placeId ? { place_id: prefill.placeId } : {}),
    }
    try {
      if (editing) await updateBudgetItem(tripId, editing.id, data)
      else await addBudgetItem(tripId, data)
      onSaved()
    } catch {
      toast.error(t('common.unknownError'))
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editing) return
    if (!deleteArmed) {
      setDeleteArmed(true)
      toast.warning(t('mobileTrip.tapAgainToDelete'))
      return
    }
    try {
      await deleteBudgetItem(tripId, editing.id)
      onSaved()
    } catch {
      toast.error(t('common.unknownError'))
      setDeleteArmed(false)
    }
  }

  const submitLabel = saving ? t('common.saving') : editing ? t('common.save') : t('common.add')

  return (
    <MSheet
      open={open}
      onClose={requestClose}
      material="opaque"
      ariaLabel={editing ? t('costs.editExpense') : t('costs.addExpense')}
    >
      <FormSheetHeader
        icon={Wallet}
        title={editing ? t('costs.editExpense') : t('costs.addExpense')}
        onClose={requestClose}
        closeLabel={t('common.close')}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[6px] pt-[2px]">
        {/* NAME */}
        <Eyebrow className="mb-[5px] mt-2 uppercase">{t('costs.whatFor')} *</Eyebrow>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('costs.namePlaceholder')}
          className={FIELD_CLS}
        />

        {/* TOTAL AMOUNT */}
        <Eyebrow className="mb-[5px] mt-3 uppercase">{t('costs.totalAmount')}</Eyebrow>
        <div className={`flex items-center gap-1 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[10px] ${isTicketMode ? 'opacity-60' : ''}`}>
          <span className="text-[0.84375rem] font-medium text-m-faint">{sym(currency)}</span>
          <NumericInput
            mode="signed-decimal"
            signToggleLabel={t('costs.toggleSign')}
            placeholder={localizeAmountInput('0.00', currency)}
            value={localizeAmountInput(isTicketMode ? ticketInfo.total.toFixed(2) : total, currency)}
            onValueChange={onTotalChange}
            disabled={isTicketMode}
            className="min-w-0 flex-1 border-0 bg-transparent text-[0.84375rem] font-semibold text-m-ink outline-none [font-variant-numeric:tabular-nums] placeholder:text-m-faint"
          />
        </div>

        {/* CURRENCY + DAY */}
        <div className="mt-3 flex gap-2">
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('costs.currency')}</Eyebrow>
            <CustomSelect
              value={currency}
              onChange={v => setCurrency(String(v))}
              searchable
              size="sm"
              options={currenciesWith(currency).map(c => ({ value: c, label: SYMBOLS[c] ? `${c}  ${SYMBOLS[c]}` : c }))}
              style={{ width: '100%' }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Eyebrow className="mb-[5px] uppercase">{t('costs.day')}</Eyebrow>
            <CustomDatePicker value={day} onChange={setDay} style={{ width: '100%' }} />
          </div>
        </div>

        {/* CONVERSION HINT */}
        {currency !== base && totalNum !== 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px] text-[0.71875rem] text-m-muted">
            <span>{formatMoney(totalNum, currency, locale)}</span>
            <span className="text-m-faint">≈</span>
            <span className="font-semibold text-m-ink">{formatMoney(convert(totalNum, currency), base, locale)}</span>
            <span className="text-m-faint">· {t('costs.liveRate')}</span>
          </div>
        )}

        {/* CATEGORY — a dropdown rather than eleven pills, which took a third of
            the sheet and pushed the split below the fold. Same shape as the
            category filter on the tab behind it. */}
        <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.category')}</Eyebrow>
        <button
          type="button"
          aria-expanded={catOpen}
          onClick={() => setCatOpen(v => !v)}
          className="flex w-full items-center gap-[10px] overflow-hidden rounded-xl border border-[color:var(--m-rowbr)] bg-m-card px-[13px] py-[11px] text-left"
        >
          {(() => {
            const meta = catMeta(cat)
            const Icon = meta.Icon
            return <Icon size={15} strokeWidth={2} style={{ color: meta.color }} className="flex-none" />
          })()}
          <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-m-ink">{t(catMeta(cat).labelKey)}</span>
          <ChevronDown size={14} strokeWidth={2} className={`flex-none text-m-faint transition-transform duration-200 ${catOpen ? 'rotate-180' : ''}`} />
        </button>
        {catOpen && (
          <div className="mt-[6px] max-h-[240px] overflow-y-auto overscroll-contain rounded-2xl border border-[color:var(--m-rowbr)] bg-[color:var(--m-glass)]">
            {COST_CATEGORY_LIST.map(c => {
              const Icon = c.Icon
              const on = cat === c.key
              return (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => { setCat(c.key); setCatOpen(false) }}
                  className="flex w-full items-center gap-[10px] border-b border-[color:var(--m-rowbr)] px-[13px] py-[11px] text-left last:border-b-0"
                >
                  <Icon size={14} strokeWidth={2} style={{ color: c.color }} className="flex-none" />
                  <span className={`flex-1 text-[0.78125rem] ${on ? 'font-bold text-m-ink' : 'font-medium text-m-muted'}`}>{t(c.labelKey)}</span>
                  {on && <Check size={14} strokeWidth={2.4} className="flex-none text-m-ink" />}
                </button>
              )
            })}
          </div>
        )}

        <MExpenseSplitFields split={split} people={people} me={me} currency={currency} />
      </div>

      <FormSheetFooter
        onDelete={editing ? handleDelete : undefined}
        deleteLabel={t('common.delete')}
        deleteArmed={deleteArmed}
        onCancel={requestClose}
        cancelLabel={t('common.cancel')}
        onSubmit={save}
        submitLabel={submitLabel}
        submitDisabled={!valid || saving}
      />
    </MSheet>
  )
}
