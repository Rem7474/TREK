import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReceiptConfirmRequest } from '@trek/shared'
import MReceiptScanSheet from '../../../../src/mobile/screens/trip/sheets/MReceiptScanSheet'
import type { TripMember } from '../../../../src/components/Budget/BudgetPanelMemberChips'
import { clearExchangeRateCache } from '../../../../src/hooks/useExchangeRates'
import { server } from '../../../helpers/msw/server'
import { resetAllStores } from '../../../helpers/store'
import { fireEvent, render, screen, waitFor } from '../../../helpers/render'

// FE-MOB-RCPTSH-001 to FE-MOB-RCPTSH-006
// The sheet reads its copy from useTranslation(), so assertions are English.

const PEOPLE = [
  { id: 1, username: 'alice', avatar_url: null },
  { id: 2, username: 'bob', avatar_url: null },
] as TripMember[]

const mealItem = {
  doc_type: 'meal',
  category: 'food',
  title: 'Chez Marcel',
  merchant: 'Chez Marcel',
  date: '2026-06-11',
  total: 86.4,
  currency: 'EUR',
  needs_review: false,
  source: { fileName: 'receipt.jpg', index: 0 },
}

function renderSheet(initialResult?: unknown, intent: 'expense' | 'booking' = 'expense') {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const view = render(
    <MReceiptScanSheet
      tripId={1}
      base="EUR"
      people={PEOPLE}
      me={1}
      intent={intent}
      initialResult={initialResult as never}
      onClose={onClose}
      onSaved={onSaved}
    />,
  )
  return { ...view, onClose, onSaved }
}

const review = () => ({ scanId: 's1', items: [mealItem], warnings: [], files: [] })

describe('MReceiptScanSheet', () => {
  beforeEach(() => {
    resetAllStores()
    clearExchangeRateCache()
    localStorage.setItem('trek_fx_EUR', JSON.stringify({ rates: { EUR: 1, USD: 1.25 }, ts: Date.now() }))
  })

  it('FE-MOB-RCPTSH-001: offers one way in, because the OS picker already holds all of them', () => {
    renderSheet()

    // A second button for the camera asked the same question twice: the picker
    // iOS and Android open already lists Camera beside Library and Files.
    expect(screen.getByRole('button', { name: /Photograph or choose a file/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Take a photo$/i })).not.toBeInTheDocument()
  })

  it('FE-MOB-RCPTSH-002: reviews the scan with the sheet\'s own split controls, not a borrowed panel', async () => {
    renderSheet(review())

    expect(await screen.findByDisplayValue('Chez Marcel')).toBeInTheDocument()
    // The three modes are the mobile sheet's segmented control — the same ones
    // the manual expense sheet offers.
    expect(screen.getByRole('button', { name: 'Equally' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ticket' })).toBeInTheDocument()
    expect(screen.getByText('Who paid?')).toBeInTheDocument()
  })

  it('FE-MOB-RCPTSH-003: saves the reviewed receipt through the confirm endpoint', async () => {
    let posted: ReceiptConfirmRequest | null = null
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest
        return HttpResponse.json({ created: [{ budget_item: { id: 5 } }], warnings: [] })
      }),
    )
    const { onSaved } = renderSheet(review())

    fireEvent.click(await screen.findByRole('button', { name: 'Save expense' }))

    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted!.scanId).toBe('s1')
    expect(posted!.items[0]).toMatchObject({
      title: 'Chez Marcel',
      total: 86.4,
      payers: [{ user_id: 1, amount: 86.4 }],
      member_ids: [1, 2],
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('FE-MOB-RCPTSH-004: opened from the planner, the itinerary choice is ticked and comes first', async () => {
    renderSheet(
      { scanId: 's1', items: [{ ...mealItem, doc_type: 'accommodation', category: 'accommodation' }], warnings: [], files: [] },
      'booking',
    )

    const toggle = await screen.findByRole('checkbox', { name: /Also add it to the itinerary/ })
    expect(toggle).toBeChecked()
  })

  it('FE-MOB-RCPTSH-005: a receipt read line by line opens on its lines', async () => {
    renderSheet({
      scanId: 's1',
      items: [{ ...mealItem, line_items: [{ name: 'Pasta', price: 40 }, { name: 'Wine', price: 46.4 }] }],
      warnings: [],
      files: [],
    })

    expect(await screen.findByDisplayValue('Pasta')).toBeInTheDocument()
  })
})
