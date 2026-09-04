import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { formatMoney, localizeAmountInput } from '../../utils/formatters'
import CustomSelect from '../shared/CustomSelect'
import GuestBadge from '../shared/GuestBadge'
import { NumericInput } from '../shared/NumericInput'
import { SPLIT_COLORS, SYMBOLS } from './BudgetPanel.constants'
import type { TripMember } from './BudgetPanelMemberChips'
import { NOTE_MAX } from './CostsPanel.helpers'
import type { ExpenseSplit } from './useExpenseSplit'

/**
 * The panels behind every screen that writes an expense: who fronted the bill,
 * how it is shared, and the note that travels with it. Moved verbatim out of the
 * Costs dialog, so the controls are defined once and rendered wherever an
 * expense is written — see useExpenseSplit for the state.
 */
interface PanelProps {
  split: ExpenseSplit
  people: TripMember[]
  me: number
  currency: string
  /** The panel wrapper's class — each screen brings its own surface. */
  className?: string
  labelCls: string
}

const sym = (c: string) => SYMBOLS[c] || (c + ' ')

/** Who fronted the bill: one payer from a dropdown, or several with amounts. */
export function ExpensePayerPanel({ split, people, me, currency, className, labelCls }: PanelProps) {
  const { t, locale } = useTranslation()
  return (
    <div className={className}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <label className={labelCls} style={{ marginBottom: 0 }}>{t('costs.whoPaid')}</label>
        <button type="button" onClick={() => (split.multiPayer ? split.disableMultiPayer() : split.enableMultiPayer())}
          className="text-content-muted"
          style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', fontWeight: 600, textDecoration: 'underline' }}>
          {split.multiPayer ? t('costs.singlePayer') : t('costs.multiplePayers')}
        </button>
      </div>
      {!split.multiPayer ? (
        <CustomSelect value={String(split.payerId)} onChange={v => split.setPayerId(Number(v))}
          options={[
            { value: '0', label: t('costs.noOnePaid') || 'Nobody (planning entry)' },
            ...people.map(p => ({ value: String(p.id), label: p.id === me ? t('costs.you') : p.username }))
          ]}
          style={{ width: '100%' }} />
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {people.map((p, idx) => {
              const on = split.payerIds.has(p.id)
              return (
                <div key={p.id} className="bg-surface-secondary border border-edge"
                  style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '8px 11px', borderRadius: 10, opacity: on ? 1 : 0.5 }}>
                  <button type="button" onClick={() => split.togglePayer(p.id)} data-testid="payer-toggle"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', padding: 0, minWidth: 0, textAlign: 'left' }}>
                    {p.avatar_url
                      ? <img src={p.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0, opacity: on ? 1 : 0.45 }} />
                      : <span style={{ width: 22, height: 22, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0, opacity: on ? 1 : 0.45 }}>
                          {(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}
                        </span>}
                    <span className="text-content" style={{ fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.id === me ? t('costs.you') : p.username}
                    </span>
                  </button>
                  {on ? (
                    <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, padding: '0 10px' }}>
                      <span className="text-content-faint" style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>{sym(currency)}</span>
                      <NumericInput mode="signed-decimal" placeholder={localizeAmountInput('0.00', currency)} data-testid="payer-amount"
                        value={localizeAmountInput(split.payerAmounts[p.id] || '', currency)}
                        onValueChange={v => split.onPayerAmountChange(p.id, v)}
                        className="text-content"
                        style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 'calc(14px * var(--fs-scale-body, 1))', fontWeight: 600, padding: '8px 0', textAlign: 'right' }} />
                    </div>
                  ) : (
                    <button type="button" onClick={() => split.togglePayer(p.id)} className="text-content-faint"
                      style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(12px * var(--fs-scale-caption, 1))', textAlign: 'right' }}>
                      {t('costs.tapToInclude')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {!split.payersOk && (
            <div style={{ marginTop: 8, fontSize: 'calc(12.5px * var(--fs-scale-caption, 1))', color: '#d97706' }}>
              {t('costs.payersUnbalanced', { amount: formatMoney(split.totalNum, currency, locale) })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** How the bill is shared: equally, by amount, or line by line. */
export function ExpenseSplitPanel({ split, people, me, currency, className, labelCls }: PanelProps) {
  const { t } = useTranslation()
  return (
    <div className={className}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <label className={labelCls} style={{ marginBottom: 0 }}>{t('costs.split') || 'Split'}</label>
        <div className="bg-surface-card border border-edge" style={{ display: 'flex', borderRadius: 999, padding: 2 }}>
          <button type="button" onClick={() => split.setSplitMode('equally')}
            className={split.splitMode === 'equally' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
            style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: split.splitMode === 'equally' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('costs.splitEqually') || 'Equally'}
          </button>
          <button type="button" onClick={() => split.setSplitMode('custom')}
            className={split.splitMode === 'custom' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
            style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: split.splitMode === 'custom' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('costs.splitCustom') || 'Custom'}
          </button>
          <button type="button" onClick={() => split.setSplitMode('ticket')}
            className={split.splitMode === 'ticket' ? 'bg-surface-secondary text-content' : 'text-content-muted'}
            style={{ padding: '4px 12px', fontSize: 'calc(11.5px * var(--fs-scale-caption, 1))', borderRadius: 999, fontWeight: 600, border: 0, background: split.splitMode === 'ticket' ? undefined : 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
            {t('costs.splitTicket') || 'Ticket'}
          </button>
        </div>
      </div>
      {split.splitMode === 'ticket' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {split.ticketItems.map(item => (
              <div key={item.id} className="bg-surface-secondary border border-edge" style={{ padding: 10, borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px auto', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    placeholder={t('costs.ticketItemName')}
                    value={item.name}
                    onChange={e => split.handleUpdateItemName(item.id, e.target.value)}
                    className="bg-surface-input border border-edge text-content"
                    style={{ minWidth: 0, padding: '6px 10px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-color)', outline: 'none' }}
                  />
                  <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', padding: '0 8px', borderRadius: 8 }}>
                    <span className="text-content-faint" style={{ fontSize: 12 }}>{sym(currency)}</span>
                    <NumericInput
                      mode="decimal"
                      placeholder={localizeAmountInput('0.00', currency)}
                      value={localizeAmountInput(item.price, currency)}
                      onValueChange={v => split.handleUpdateItemPrice(item.id, v)}
                      className="text-content"
                      style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 13, fontWeight: 600, textAlign: 'right', padding: '6px 0' }}
                    />
                  </div>
                  <button type="button" onClick={() => split.handleRemoveItem(item.id)} className="text-content-muted" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 4 }}>
                    <Trash2 size={15} />
                  </button>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
                  <span className="text-content-faint" style={{ fontSize: 10.5, fontWeight: 600, textTransform: 'uppercase', marginRight: 4 }}>{t('costs.ticketSplitting')}</span>
                  {people.map((p, pIdx) => {
                    const active = item.participants.has(p.id)
                    return (
                      <button
                        type="button"
                        key={p.id}
                        onClick={() => split.handleToggleItemParticipant(item.id, p.id)}
                        className={active ? 'bg-surface-card text-content border' : 'bg-surface-secondary text-content-muted border border-edge'}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', border: active ? '1px solid var(--text-primary)' : undefined }}
                      >
                        {p.avatar_url
                          ? <img src={p.avatar_url} alt="" style={{ width: 14, height: 14, borderRadius: '50%', objectFit: 'cover' }} />
                          : <span style={{ width: 14, height: 14, borderRadius: '50%', background: SPLIT_COLORS[pIdx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 7, fontWeight: 700 }}>{(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}</span>}
                        <span>{p.id === me ? t('costs.you') : p.username}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <button type="button" onClick={split.handleAddEmptyItem} className="border border-dashed border-edge text-content-muted" style={{ padding: '8px 12px', borderRadius: 10, background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Plus size={14} /> {t('costs.ticketAddItem')}
          </button>

          {split.ticketItems.length > 0 && (
            <div className="bg-surface-secondary border border-edge" style={{ padding: 12, borderRadius: 10 }}>
              <div className="text-content" style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t('costs.ticketShares')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {people.map(p => {
                  const share = split.ticketInfo.shares[p.id] || 0
                  return (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span className="text-content-muted">{p.id === me ? t('costs.you') : p.username}</span>
                      <span className="text-content" style={{ fontWeight: 600 }}>{sym(currency)}{share.toFixed(2)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {people.map((p, idx) => {
              const on = split.participants.has(p.id)
              return (
                <div key={p.id} className="bg-surface-secondary border border-edge" style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '8px 11px', borderRadius: 10, opacity: on ? 1 : 0.5 }}>
                  <button type="button" onClick={() => split.toggleParticipant(p.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', padding: 0, minWidth: 0, textAlign: 'left' }}>
                    {p.avatar_url
                      ? <img src={p.avatar_url} alt="" style={{ width: 22, height: 22, borderRadius: '50%', objectFit: 'cover', display: 'block', flexShrink: 0, opacity: on ? 1 : 0.45 }} />
                      : <span style={{ width: 22, height: 22, borderRadius: '50%', background: SPLIT_COLORS[idx % SPLIT_COLORS.length].gradient, color: '#fff', display: 'grid', placeItems: 'center', fontSize: 9, fontWeight: 700, flexShrink: 0, opacity: on ? 1 : 0.45 }}>{(p.id === me ? t('costs.youShort') : p.username.charAt(0)).toUpperCase()}</span>}
                    <span className="text-content" style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.id === me ? t('costs.you') : p.username}</span>
                    {p.is_guest && <GuestBadge size="xs" />}
                  </button>
                  {split.splitMode === 'equally' ? (
                    on ? (
                      <span className="text-content" style={{ fontSize: 14, fontWeight: 600, textAlign: 'right', paddingRight: 10 }}>
                        {sym(currency)}{(split.equalShares[p.id] || 0).toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-content-faint" style={{ fontSize: 12, textAlign: 'right', paddingRight: 10 }}>{t('costs.excluded')}</span>
                    )
                  ) : (
                    on ? (
                      <div className="bg-surface-input border border-edge" style={{ display: 'flex', alignItems: 'center', gap: 4, borderRadius: 8, padding: '0 10px' }}>
                        <span className="text-content-faint" style={{ fontSize: 13 }}>{sym(currency)}</span>
                        <input type="text" inputMode="decimal" placeholder={localizeAmountInput((split.placeholderShares[p.id] || 0).toFixed(2), currency)} value={localizeAmountInput(split.customAmounts[p.id] || '', currency)}
                          onChange={e => split.handleCustomAmountChange(p.id, e.target.value)}
                          className="text-content" style={{ width: '100%', border: 0, background: 'none', outline: 'none', fontSize: 14, fontWeight: 600, padding: '8px 0', textAlign: 'right' }} />
                      </div>
                    ) : (
                      <button type="button" onClick={() => split.toggleParticipant(p.id)} className="text-content-faint" style={{ background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, textAlign: 'right' }}>{t('costs.tapToInclude')}</button>
                    )
                  )}
                </div>
              )
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 12.5, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            {split.splitMode === 'equally' ? (
              <span className="text-content-faint">
                {split.participants.size > 0 && t('costs.splitSummary', { count: split.participants.size, amount: sym(currency) + split.each.toFixed(2) })}
              </span>
            ) : (
              <span style={{ fontWeight: 600, color: split.customBalanced ? '#16a34a' : '#dc2626' }}>
                {split.customBalanced
                  ? t('costs.splitBalanced')
                  : t(split.splitShortfall > 0 ? 'costs.splitSumUnder' : 'costs.splitSumOver', {
                      sum: sym(currency) + split.splitSum.toFixed(2),
                      total: sym(currency) + split.totalNum.toFixed(2),
                      diff: sym(currency) + Math.abs(split.splitShortfall).toFixed(2),
                    })}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** The free-text note that travels with the expense. */
export function ExpenseNotePanel({ split, className, labelCls, inputCls, id = 'expense-note' }: {
  split: ExpenseSplit
  className?: string
  labelCls: string
  inputCls: string
  id?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={className}>
      <label className={labelCls} htmlFor={id}>{t('costs.note')}</label>
      <textarea id={id} value={split.note} onChange={e => split.setNote(e.target.value)} rows={2}
        placeholder={t('costs.notePlaceholder')} maxLength={NOTE_MAX}
        className={inputCls} style={{ borderRadius: 10, padding: '10px 13px', fontSize: 'calc(13.5px * var(--fs-scale-body, 1))', outline: 'none', resize: 'vertical', minHeight: 68, width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.5 }} />
    </div>
  )
}
