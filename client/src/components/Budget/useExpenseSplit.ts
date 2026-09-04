import { useEffect, useMemo, useState } from 'react'
import type { BudgetItem } from '../../types'
import type { TripMember } from './BudgetPanelMemberChips'
import { amountToInputString } from '../../utils/formatters'
import { amountPattern, calculateTicketShares, hasTicketSplit, payersBalanced, readTicketItems, readUserNote, rebalancePayers, splitEqualShares, writeTicketItems, type TicketItem } from './CostsPanel.helpers'

/**
 * How an expense is paid for and shared — the one editor behind every screen
 * that writes an expense.
 *
 * It used to live inline in the Costs dialog (ExpenseModal). The receipt scanner
 * writes the same expense from a photograph, and reviewing a scan with a lesser
 * set of controls than typing the same expense by hand is a difference the user
 * has no reason to expect: the scan fills the fields in, it does not take any
 * away. Extracting the state keeps the two in step by construction rather than
 * by vigilance. The panels that render it live in ExpenseSplitEditor.
 */

export type SplitMode = 'equally' | 'custom' | 'ticket'

/** The split as the API takes it — what both writers send. */
export interface ExpenseSplitPayload {
  payers: { user_id: number; amount: number }[]
  members: { user_id: number; amount: number | null }[]
  member_ids: number[]
  /** The receipt's lines, kept whether or not they drive the split. */
  ticket_json: string | null
  /** How the total is divided — said outright, not read off ticket_json. */
  split_mode: SplitMode
  note: string | null
}

/** One line of a scanned receipt, as the ticket editor can be seeded with. */
export interface SeedLine {
  name: string
  price: number
}

/**
 * Receipt lines as ticket rows, shared by everybody on the trip.
 *
 * A shortfall against the total becomes one trailing line: the ticket editor
 * recomputes the expense total from its own rows, so lines that do not add up
 * to what was actually paid would quietly rewrite the amount. Lines that
 * overshoot (a discount the model missed) seed nothing — there is no honest
 * guess to make.
 */
export function ticketItemsFromLines(lines: SeedLine[], total: number, people: TripMember[]): TicketItem[] {
  if (lines.length === 0) return []
  const everyone = () => new Set(people.map(p => p.id))
  const sum = lines.reduce((acc, l) => acc + l.price, 0)
  const missing = Math.round((total - sum) * 100) / 100
  if (missing < -0.01) return []
  const rows = lines.map((l, i) => ({ id: `seed-${i}`, name: l.name, price: String(l.price), participants: everyone() }))
  // Same wording the server writes when it seeds a ticket from a scan
  // (receipts.service.ts), so a receipt reads the same whichever side filled it in.
  if (missing > 0.01) rows.push({ id: 'seed-tax', name: 'Tax & service', price: String(missing), participants: everyone() })
  return rows
}

/** A ticket row somebody could actually save: named, priced, and shared by someone. */
function isUsableLine(line: TicketItem): boolean {
  return line.name.trim().length > 0 && (parseFloat(line.price) || 0) > 0 && line.participants.size > 0
}

export interface ExpenseSplit {
  splitMode: SplitMode
  setSplitMode: (mode: SplitMode) => void
  isTicketMode: boolean
  participants: Set<number>
  payerId: number
  setPayerId: (id: number) => void
  multiPayer: boolean
  payerIds: Set<number>
  payerAmounts: Record<number, string>
  customAmounts: Record<number, string>
  ticketItems: TicketItem[]
  note: string
  setNote: (note: string) => void
  /** The expense total: typed, or derived from the ticket rows in ticket mode. */
  totalNum: number
  ticketInfo: { shares: Record<number, number>; total: number }
  equalShares: Record<number, number>
  placeholderShares: Record<number, number>
  splitSum: number
  customBalanced: boolean
  /** What is left to hand out, signed the same way as the total (#2176). */
  splitShortfall: number
  each: number
  payersOk: boolean
  ticketValid: boolean
  /** True when the split itself is saveable; the caller still checks name and amount. */
  splitValid: boolean
  enableMultiPayer: () => void
  disableMultiPayer: () => void
  togglePayer: (id: number) => void
  onPayerAmountChange: (id: number, value: string) => void
  handleCustomAmountChange: (id: number, value: string) => void
  toggleParticipant: (id: number) => void
  handleAddEmptyItem: () => void
  handleUpdateItemName: (id: string, name: string) => void
  handleUpdateItemPrice: (id: string, price: string) => void
  handleRemoveItem: (id: string) => void
  handleToggleItemParticipant: (itemId: string, userId: number) => void
  buildPayload: () => ExpenseSplitPayload
}

export function useExpenseSplit({ people, me, editing = null, seedLines, seedNote, total, currency }: {
  people: TripMember[]
  me: number
  /** Currency of the amounts being edited — decides how many decimals a seed is padded to. */
  currency: string
  /** The expense being edited — seeds payers, shares, split mode and note. */
  editing?: BudgetItem | null
  /** Lines a scan read off a receipt: what the ticket editor opens with. */
  seedLines?: SeedLine[]
  /** A note the caller starts from, when there is no expense to read one off. */
  seedNote?: string
  /** The typed amount. Ignored in ticket mode, where the rows are the total. */
  total: number
}): ExpenseSplit {
  const [participants, setParticipants] = useState<Set<number>>(() =>
    editing ? new Set((editing.members || []).map(m => m.user_id)) : new Set(people.map(p => p.id)))

  // Payer state. An expense can be fronted by several people, each with their own
  // amount (budget_item_payers) — a shared card, or "I got this round, you get the
  // next". The single-payer dropdown stays the default path; multiPayer swaps in a
  // per-person amount editor. 0 represents "Nobody (planning entry)"; on an
  // existing expense a missing payer is a deliberate choice, so only a brand-new
  // one defaults to me.
  // A negative payer (the recipient of a refund, #2176) is a real payer —
  // filtering on > 0 here would silently drop them on save.
  const initialPayers = (editing?.payers || []).filter(p => p.amount !== 0)

  const [payerId, setPayerId] = useState<number>(() => {
    const existingPayer = initialPayers[0]
    if (existingPayer) return existingPayer.user_id
    return editing ? 0 : me
  })
  const [multiPayer, setMultiPayer] = useState(() => initialPayers.length > 1)
  const [payerIds, setPayerIds] = useState<Set<number>>(() => new Set(initialPayers.map(p => p.user_id)))
  const [payerAmounts, setPayerAmounts] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    for (const p of initialPayers) m[p.user_id] = amountToInputString(p.amount, currency)
    return m
  })
  // Payers the user typed an amount for: rebalance leaves these alone and makes
  // the others absorb the remainder.
  const [pinnedPayers, setPinnedPayers] = useState<Set<number>>(() => new Set(initialPayers.map(p => p.user_id)))

  const [ticketItems, setTicketItems] = useState<TicketItem[]>(() => {
    const existing = readTicketItems(editing)
    if (existing.length > 0 || !seedLines) return existing
    return ticketItemsFromLines(seedLines, total, people)
  })

  const [splitMode, setSplitMode] = useState<SplitMode>(() => {
    // hasTicketSplit reads the expense's own split_mode when it has one, and
    // falls back to "a stored ticket meant a ticket split" for older rows.
    if (hasTicketSplit(editing)) {
      return 'ticket'
    }
    if (editing && editing.members && editing.members.length > 0) {
      const hasCustom = editing.members.some(m => m.amount !== null && m.amount !== undefined)
      return hasCustom ? 'custom' : 'equally'
    }
    // A scan that read the receipt line by line opens on those lines, which is
    // the finest split the document supports — and the one the server used to
    // write behind the reviewer's back before they could see it.
    if (!editing && ticketItems.length > 0 && ticketItems.every(isUsableLine)) return 'ticket'
    return 'equally'
  })

  const [note, setNote] = useState(() => readUserNote(editing) || seedNote || '')

  const [customAmounts, setCustomAmounts] = useState<Record<number, string>>(() => {
    const m: Record<number, string> = {}
    if (editing && editing.members) {
      for (const member of editing.members) {
        if (member.amount !== null && member.amount !== undefined) {
          m[member.user_id] = amountToInputString(member.amount, currency)
        }
      }
    }
    return m
  })

  const isTicketMode = splitMode === 'ticket'

  const ticketInfo = useMemo(() => {
    return calculateTicketShares(ticketItems)
  }, [ticketItems])

  const totalNum = isTicketMode ? ticketInfo.total : total
  const splitSum = [...participants].reduce((sum, id) => sum + (parseFloat(customAmounts[id]) || 0), 0)
  const customBalanced = Math.round(splitSum * 100) === Math.round(totalNum * 100)
  // How much is still to be handed out, read on the total's own side: on a refund
  // (#2176) the shares run negative, so a plain total minus sum flips under and
  // over around and sends the user the wrong way.
  const splitShortfall = totalNum < 0 ? splitSum - totalNum : totalNum - splitSum
  const each = participants.size > 0 ? totalNum / participants.size : 0
  const equalShares = useMemo(() => {
    return splitEqualShares(totalNum, [...participants].map(id => ({ user_id: id })), editing?.id || 0)
  }, [totalNum, participants, editing])

  const placeholderShares = useMemo(() => {
    const emptyParts = [...participants].filter(id => !customAmounts[id])
    if (emptyParts.length === 0) return {}

    const enteredSum = [...participants]
      .filter(id => customAmounts[id])
      .reduce((sum, id) => sum + (parseFloat(customAmounts[id]) || 0), 0)
    // Clamped toward zero on the total's own side, so an over-entered positive
    // split never suggests negative leftovers — while a negative total (#2176)
    // still previews its negative equal shares.
    const rest = totalNum - enteredSum
    const remaining = totalNum >= 0 ? Math.max(0, rest) : Math.min(0, rest)

    return splitEqualShares(remaining, emptyParts.map(id => ({ user_id: id })), editing?.id || 0)
  }, [totalNum, participants, customAmounts, editing])

  const ticketValid = ticketItems.length > 0 && ticketItems.every(isUsableLine)
  const payersOk = !multiPayer || (payerIds.size > 0 && payersBalanced(payerAmounts, payerIds, totalNum))
  // A negative total is a valid entry (a refund, #2176); only zero has nothing to say.
  const splitValid = payersOk && (
    isTicketMode
      ? ticketValid
      : totalNum !== 0 && (participants.size === 0 || splitMode === 'equally' || customBalanced)
  )

  // Keep the payer amounts summing to the total as it changes — including in ticket
  // mode, where the total is derived from the ticket items rather than typed.
  useEffect(() => {
    if (!multiPayer) return
    setPayerAmounts(prev => rebalancePayers(prev, pinnedPayers, payerIds, totalNum))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalNum])

  const enableMultiPayer = () => {
    const seed = payerIds.size > 0 ? new Set(payerIds) : new Set<number>([payerId > 0 ? payerId : me])
    const pinned = new Set<number>()
    setPayerIds(seed)
    setPinnedPayers(pinned)
    setPayerAmounts(prev => rebalancePayers(prev, pinned, seed, totalNum))
    setMultiPayer(true)
  }

  const disableMultiPayer = () => {
    // Collapsing back keeps the first payer; their amount becomes the whole total.
    const [first] = [...payerIds]
    setPayerId(first ?? me)
    setMultiPayer(false)
  }

  const togglePayer = (id: number) => {
    const nextIds = new Set(payerIds)
    const nextPinned = new Set(pinnedPayers)
    if (nextIds.has(id)) {
      nextIds.delete(id)
      nextPinned.delete(id)
    } else {
      nextIds.add(id)
    }
    setPayerIds(nextIds)
    setPinnedPayers(nextPinned)
    setPayerAmounts(prev => rebalancePayers(prev, nextPinned, nextIds, totalNum))
  }

  const onPayerAmountChange = (id: number, v: string) => {
    const val = v.replace(',', '.')
    const nextPinned = new Set(pinnedPayers)
    nextPinned.add(id)
    setPinnedPayers(nextPinned)
    setPayerAmounts(prev => rebalancePayers({ ...prev, [id]: val }, nextPinned, payerIds, totalNum))
  }

  const handleCustomAmountChange = (id: number, val: string) => {
    val = val.replace(',', '.')
    // Currency-aware precision (#2175): a three-decimal currency seeds three places,
    // and a fixed two rejected every keystroke after that.
    if (val === '' || amountPattern(currency, true).test(val)) {
      setCustomAmounts(prev => ({ ...prev, [id]: val }))
    }
  }

  const handleAddEmptyItem = () => {
    setTicketItems(prev => [
      ...prev,
      {
        id: String(Date.now() + Math.random()),
        name: '',
        price: '',
        participants: new Set(people.map(p => p.id))
      }
    ])
  }

  const handleUpdateItemName = (id: string, name: string) => {
    setTicketItems(prev => prev.map(item => item.id === id ? { ...item, name } : item))
  }

  const handleUpdateItemPrice = (id: string, price: string) => {
    price = price.replace(',', '.')
    if (price === '' || amountPattern(currency, false).test(price)) {
      setTicketItems(prev => prev.map(item => item.id === id ? { ...item, price } : item))
    }
  }

  const handleRemoveItem = (id: string) => {
    setTicketItems(prev => prev.filter(item => item.id !== id))
  }

  const handleToggleItemParticipant = (itemId: string, userId: number) => {
    setTicketItems(prev => prev.map(item => {
      if (item.id === itemId) {
        const nextParts = new Set(item.participants)
        if (nextParts.has(userId)) nextParts.delete(userId)
        else nextParts.add(userId)
        return { ...item, participants: nextParts }
      }
      return item
    }))
  }

  const toggleParticipant = (id: number) => {
    const nextParts = new Set(participants)
    if (nextParts.has(id)) {
      nextParts.delete(id)
      setCustomAmounts(prev => {
        const copy = { ...prev }
        delete copy[id]
        return copy
      })
    } else {
      nextParts.add(id)
    }
    setParticipants(nextParts)
  }

  const buildPayload = (): ExpenseSplitPayload => {
    // A picked payer always goes out, even when nobody shares the expense: the
    // server re-derives total_price from the payer sum (CostsPanel.helpers), so
    // dropping the payer would store the entry with a total of 0.
    const payers = multiPayer
      ? [...payerIds]
          .map(id => ({ user_id: id, amount: parseFloat(payerAmounts[id]) || 0 }))
          .filter(p => p.amount !== 0)
      : payerId > 0 ? [{ user_id: payerId, amount: totalNum }] : []
    // A receipt line can name somebody who is not ticked as a participant. Sending
    // only the ticked set would drop their share, leaving the member sum short of
    // total_price and handing the settlement a difference it can never clear (#1382).
    const member_ids = splitMode === 'ticket'
      ? [...new Set([...participants, ...Object.keys(ticketInfo.shares).map(Number)])].sort((a, b) => a - b)
      : [...participants]
    const members = member_ids.map(id => ({
      user_id: id,
      amount: splitMode === 'custom'
        ? (parseFloat(customAmounts[id]) || 0)
        : splitMode === 'ticket'
        ? (ticketInfo.shares[id] || 0)
        : null
    }))
    return {
      payers,
      members,
      member_ids,
      // The lines go out whenever there are any. They are what the receipt said,
      // and losing them because the bill was split evenly served nobody — the
      // mode below is what decides how the money is divided.
      ticket_json: ticketItems.length > 0 ? writeTicketItems(ticketItems) : null,
      split_mode: splitMode,
      note: note.trim() || null,
    }
  }

  return {
    splitMode, setSplitMode, isTicketMode, participants, payerId, setPayerId, multiPayer, payerIds,
    payerAmounts, customAmounts, ticketItems, note, setNote, totalNum, ticketInfo, equalShares,
    placeholderShares, splitSum, customBalanced, splitShortfall, each, payersOk, ticketValid, splitValid,
    enableMultiPayer, disableMultiPayer, togglePayer, onPayerAmountChange, handleCustomAmountChange,
    toggleParticipant, handleAddEmptyItem, handleUpdateItemName, handleUpdateItemPrice,
    handleRemoveItem, handleToggleItemParticipant, buildPayload,
  }
}
