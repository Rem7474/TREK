// FE-HOOK-RSC-001 to FE-HOOK-RSC-004
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../tests/helpers/msw/server'
import { useReceiptScanCapability } from './useReceiptScanCapability'

const features = (body: Record<string, unknown>) =>
  http.get('/api/health/features', () => HttpResponse.json(body))

describe('useReceiptScanCapability', () => {
  it('FE-HOOK-RSC-001: reports the feature and the photo answer when both say yes', async () => {
    server.use(
      features({ bookingImport: true, aiParsing: true, receiptScan: true }),
      http.get('/api/llm/capabilities', () => HttpResponse.json({ configured: true, photos: true })),
    )
    const { result } = renderHook(() => useReceiptScanCapability())
    await waitFor(() => expect(result.current).toEqual({ available: true, photos: true }))
  })

  it('FE-HOOK-RSC-002: a text-only model keeps the scanner and loses the camera', async () => {
    // The scanner still reads a PDF invoice — this narrows what it offers.
    server.use(
      features({ bookingImport: true, aiParsing: true, receiptScan: true }),
      http.get('/api/llm/capabilities', () => HttpResponse.json({ configured: true, photos: false })),
    )
    const { result } = renderHook(() => useReceiptScanCapability())
    await waitFor(() => expect(result.current).toEqual({ available: true, photos: false }))
  })

  it('FE-HOOK-RSC-003: never asks whose model it is when the instance has the feature off', async () => {
    let asked = 0
    server.use(
      features({ bookingImport: true, aiParsing: false, receiptScan: false }),
      http.get('/api/llm/capabilities', () => { asked += 1; return HttpResponse.json({ configured: false, photos: false }) }),
    )
    const { result } = renderHook(() => useReceiptScanCapability())
    await waitFor(() => expect(result.current).toEqual({ available: false, photos: false }))
    expect(asked).toBe(0)
  })

  it('FE-HOOK-RSC-004: a capabilities call that fails only costs the photo affordances', async () => {
    server.use(
      features({ bookingImport: true, aiParsing: true, receiptScan: true }),
      http.get('/api/llm/capabilities', () => HttpResponse.error()),
    )
    const { result } = renderHook(() => useReceiptScanCapability())
    await waitFor(() => expect(result.current).toEqual({ available: true, photos: false }))
  })

  it('FE-HOOK-RSC-005: an unreachable server offers nothing rather than a button that fails', async () => {
    server.use(http.get('/api/health/features', () => HttpResponse.error()))
    const { result } = renderHook(() => useReceiptScanCapability())
    await waitFor(() => expect(result.current).toEqual({ available: false, photos: false }))
  })
})
