import { Plus, Trash2 } from 'lucide-react'
import GuestBadge from '../../../../components/shared/GuestBadge'
import { NumericInput } from '../../../../components/shared/NumericInput'
import CustomSelect from '../../../../components/shared/CustomSelect'
import { SPLIT_COLORS, SYMBOLS } from '../../../../components/Budget/BudgetPanel.constants'
import type { TripMember } from '../../../../components/Budget/BudgetPanelMemberChips'
import { NOTE_MAX } from '../../../../components/Budget/CostsPanel.helpers'
import type { ExpenseSplit } from '../../../../components/Budget/useExpenseSplit'
import { useTranslation } from '../../../../i18n'
import { formatMoney, localizeAmountInput } from '../../../../utils/formatters'
import { Eyebrow, FIELD_AREA_CLS } from './PlSheetChrome'

/**
 * Who paid, how it is shared, and the note — in the mobile shell's own idiom.
 *
 * The desktop dialog has the same three fields (ExpenseSplitEditor) and both are
 * driven by the same state (useExpenseSplit): what differs here is only the
 * chrome, which is the whole point of the shell. Extracted from MCostSheet so
 * that anything writing an expense on a phone reaches for the sheet's own
 * controls rather than borrowing the desktop panel.
 */

// Nested surfaces for the split/payer rows on the opaque sheet: the row sits on
// --m-ic, the amount box drops back to the solid sheet fill so it reads as a
// distinct input in both themes.
const ROW_CLS = 'flex items-center gap-[9px] rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] px-3 py-[9px]'
const MINI_INPUT_WRAP = 'flex items-center gap-1 rounded-[9px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] px-[10px]'

const SPLIT_MODES = [
  { id: 'equally', labelKey: 'costs.splitEqually' },
  { id: 'custom', labelKey: 'costs.splitCustom' },
  { id: 'ticket', labelKey: 'costs.splitTicket' },
] as const

export default function MExpenseSplitFields({ split, people, me, currency }: {
  split: ExpenseSplit
  people: TripMember[]
  me: number
  currency: string
}) {
  const { t, locale } = useTranslation()
  const sym = (c: string) => SYMBOLS[c] || c + ' '
  const nameOf = (p: TripMember) => (p.id === me ? t('costs.you') : p.username)
  const initialOf = (p: TripMember) => (p.id === me ? t('costs.youShort') : (p.username || '?').charAt(0)).toUpperCase()

  const Avatar = ({ p, idx, size = 22, dim = false }: { p: TripMember; idx: number; size?: number; dim?: boolean }) =>
    p.avatar_url
      ? <img src={p.avatar_url} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, opacity: dim ? 0.45 : 1 }} />
      : (
        <span
          style={{
            width: size, height: size, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient,
            color: '#fff', display: 'grid', placeItems: 'center', fontSize: size * 0.4, fontWeight: 700, flexShrink: 0, opacity: dim ? 0.45 : 1,
          }}
        >
          {initialOf(p)}
        </span>
      )

  return (
    <>
      {/* WHO PAID */}
      <div className="mb-[6px] mt-3 flex items-center justify-between">
        <Eyebrow className="uppercase">{t('costs.whoPaid')}</Eyebrow>
        <button
          type="button"
          onClick={() => (split.multiPayer ? split.disableMultiPayer() : split.enableMultiPayer())}
          className="font-geist text-[0.625rem] font-semibold text-m-muted underline"
        >
          {split.multiPayer ? t('costs.singlePayer') : t('costs.multiplePayers')}
        </button>
      </div>
      {!split.multiPayer ? (
        <CustomSelect
          value={String(split.payerId)}
          onChange={v => split.setPayerId(Number(v))}
          size="sm"
          options={[
            { value: '0', label: t('costs.noOnePaid') },
            ...people.map(p => ({ value: String(p.id), label: nameOf(p) })),
          ]}
          style={{ width: '100%' }}
        />
      ) : (
        <>
          <div className="flex flex-col gap-[6px]">
            {people.map((p, idx) => {
              const on = split.payerIds.has(p.id)
              return (
                <div key={p.id} className={`${ROW_CLS} ${on ? '' : 'opacity-60'}`}>
                  <button
                    type="button"
                    onClick={() => split.togglePayer(p.id)}
                    className="flex min-w-0 flex-1 items-center gap-[8px] text-left"
                  >
                    <Avatar p={p} idx={idx} dim={!on} />
                    <span className="truncate text-[0.8125rem] font-medium text-m-ink">{nameOf(p)}</span>
                  </button>
                  {on ? (
                    <div className={`${MINI_INPUT_WRAP} w-[120px] flex-none`}>
                      <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                      <NumericInput
                        mode="signed-decimal"
                        placeholder={localizeAmountInput('0.00', currency)}
                        value={localizeAmountInput(split.payerAmounts[p.id] || '', currency)}
                        onValueChange={v => split.onPayerAmountChange(p.id, v)}
                        className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none"
                      />
                    </div>
                  ) : (
                    <button type="button" onClick={() => split.togglePayer(p.id)} className="flex-none text-[0.6875rem] text-m-faint">
                      {t('costs.tapToInclude')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {!split.payersOk && (
            <div className="mt-2 text-[0.6875rem] text-[color:var(--m-st-danger)]">
              {t('costs.payersUnbalanced', { amount: formatMoney(split.totalNum, currency, locale) })}
            </div>
          )}
        </>
      )}

      {/* SPLIT */}
      <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.split')}</Eyebrow>
      <div className="flex rounded-full bg-[color:var(--m-ic)] p-[3px]">
        {SPLIT_MODES.map(m => (
          <button
            key={m.id}
            type="button"
            onClick={() => split.setSplitMode(m.id)}
            className={`flex-1 rounded-full py-[7px] text-[0.71875rem] font-semibold ${split.splitMode === m.id ? 'bg-m-act text-m-actfg' : 'text-m-muted'}`}
          >
            {t(m.labelKey)}
          </button>
        ))}
      </div>

      {split.isTicketMode ? (
        <div className="mt-2 flex flex-col gap-2">
          {split.ticketItems.map(item => (
            <div key={item.id} className="flex flex-col gap-2 rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-[10px]">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder={t('costs.whatFor')}
                  value={item.name}
                  onChange={e => split.handleUpdateItemName(item.id, e.target.value)}
                  className="min-w-0 flex-[2] rounded-[9px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] px-[10px] py-[7px] text-[0.8125rem] font-medium text-m-ink outline-none placeholder:text-m-faint"
                />
                <div className={`${MINI_INPUT_WRAP} min-w-0 flex-1`}>
                  <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                  <NumericInput
                    mode="decimal"
                    placeholder={localizeAmountInput('0.00', currency)}
                    value={localizeAmountInput(item.price, currency)}
                    onValueChange={v => split.handleUpdateItemPrice(item.id, v)}
                    className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none"
                  />
                </div>
                <button type="button" onClick={() => split.handleRemoveItem(item.id)} className="flex-none text-m-muted" aria-label={t('common.delete')}>
                  <Trash2 size={15} strokeWidth={2} />
                </button>
              </div>
              <div className="flex flex-wrap gap-[5px]">
                {people.map((p, idx) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => split.handleToggleItemParticipant(item.id, p.id)}
                    className={`flex items-center gap-[4px] rounded-full px-[8px] py-[3px] text-[0.6875rem] font-medium ${
                      item.participants.has(p.id) ? 'bg-m-act text-m-actfg' : 'border border-[color:var(--m-rowbr)] bg-[color:var(--m-sheetop)] text-m-muted'
                    }`}
                  >
                    <Avatar p={p} idx={idx} size={14} dim={!item.participants.has(p.id)} />
                    <span>{nameOf(p)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={split.handleAddEmptyItem}
            className="flex items-center justify-center gap-[6px] rounded-[12px] border border-dashed border-[color:var(--m-rowbr)] py-[10px] text-[0.78125rem] font-semibold text-m-muted"
          >
            <Plus size={14} strokeWidth={2.2} /> {t('common.add')}
          </button>
          {split.ticketItems.length > 0 && (
            <div className="rounded-[12px] border border-[color:var(--m-rowbr)] bg-[color:var(--m-ic)] p-3">
              <Eyebrow className="mb-[8px] uppercase">{t('costs.split')}</Eyebrow>
              <div className="flex flex-col gap-1">
                {people.map(p => (
                  <div key={p.id} className="flex justify-between text-[0.8125rem]">
                    <span className="text-m-muted">{nameOf(p)}</span>
                    <span className="font-semibold text-m-ink [font-variant-numeric:tabular-nums]">{sym(currency)}{(split.ticketInfo.shares[p.id] || 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="mt-2 flex flex-col gap-[6px]">
            {people.map((p, idx) => {
              const on = split.participants.has(p.id)
              return (
                <div key={p.id} className={`${ROW_CLS} ${on ? '' : 'opacity-60'}`}>
                  <button
                    type="button"
                    onClick={() => split.toggleParticipant(p.id)}
                    className="flex min-w-0 flex-1 items-center gap-[8px] text-left"
                  >
                    <Avatar p={p} idx={idx} dim={!on} />
                    <span className="truncate text-[0.8125rem] font-medium text-m-ink">{nameOf(p)}</span>
                    {p.is_guest && <GuestBadge size="xs" />}
                  </button>
                  {split.splitMode === 'equally' ? (
                    on ? (
                      <span className="flex-none pr-1 text-[0.8125rem] font-semibold text-m-ink [font-variant-numeric:tabular-nums]">
                        {sym(currency)}{(split.equalShares[p.id] || 0).toFixed(2)}
                      </span>
                    ) : (
                      <span className="flex-none pr-1 text-[0.6875rem] text-m-faint">{t('costs.tapToInclude')}</span>
                    )
                  ) : on ? (
                    <div className={`${MINI_INPUT_WRAP} w-[120px] flex-none`}>
                      <span className="text-[0.75rem] text-m-faint">{sym(currency)}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={localizeAmountInput((split.placeholderShares[p.id] || 0).toFixed(2), currency)}
                        value={localizeAmountInput(split.customAmounts[p.id] || '', currency)}
                        onChange={e => split.handleCustomAmountChange(p.id, e.target.value)}
                        className="w-full border-0 bg-transparent py-[7px] text-right text-[0.8125rem] font-semibold text-m-ink outline-none placeholder:text-m-faint"
                      />
                    </div>
                  ) : (
                    <button type="button" onClick={() => split.toggleParticipant(p.id)} className="flex-none text-[0.6875rem] text-m-faint">
                      {t('costs.tapToInclude')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-2 text-[0.71875rem]">
            {split.splitMode === 'equally' ? (
              <span className="text-m-faint">
                {split.participants.size > 0 && t('costs.splitSummary', { count: split.participants.size, amount: sym(currency) + split.each.toFixed(2) })}
              </span>
            ) : (
              <span className={`font-semibold ${split.customBalanced ? 'text-[#16a34a]' : 'text-[color:var(--m-st-danger)]'}`}>
                {split.customBalanced
                  ? t('costs.splitSummary', { count: split.participants.size, amount: sym(currency) + split.each.toFixed(2) })
                  : `${sym(currency)}${split.splitSum.toFixed(2)} / ${sym(currency)}${split.totalNum.toFixed(2)}`}
              </span>
            )}
          </div>
        </>
      )}

      {/* NOTE — last, because it is the one field that is never required. The
          room for it came from folding the category pills into a dropdown. */}
      <Eyebrow className="mb-[6px] mt-3 uppercase">{t('costs.note')}</Eyebrow>
      <textarea
        value={split.note}
        onChange={e => split.setNote(e.target.value)}
        rows={2}
        maxLength={NOTE_MAX}
        placeholder={t('costs.notePlaceholder')}
        className={FIELD_AREA_CLS}
      />
    </>
  )
}
