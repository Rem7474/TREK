import { useEffect, useState } from 'react'
import { healthApi, llmApi } from '../api/client'

/**
 * Whether this instance offers receipt scanning, and whether the model behind it
 * can be handed a photograph.
 *
 * Two questions with two different answers, and a button needs both before it is
 * drawn. `/api/health/features` is public, so it can say the addons are on but not
 * whose model is configured or what it reads; `/api/llm/capabilities` answers for
 * the caller. A text-only model still reads a PDF invoice, so `photos` narrows what
 * the scanner offers — no camera, no image types in the picker — rather than hiding
 * the feature.
 *
 * One hook because the Costs panel and the planner (and through it the phone shell)
 * both ask, and two copies of the same pair of requests is the hand-mirrored state
 * this codebase is meant not to grow. Deliberately no module-level cache: a shared
 * mutable answer is the other thing it is meant not to grow, and the saving would
 * be one request per mount.
 */
export function useReceiptScanCapability(): { available: boolean; photos: boolean } {
  const [state, setState] = useState({ available: false, photos: false })

  useEffect(() => {
    let cancelled = false
    healthApi
      .features()
      .then(async f => {
        if (!f.receiptScan) return { available: false, photos: false }
        // A refused capability call is not a refused feature: the scanner still
        // reads a PDF, so only the photo affordances stand down.
        const caps = await llmApi.capabilities().catch(() => ({ photos: false }))
        return { available: true, photos: !!caps.photos }
      })
      .catch(() => ({ available: false, photos: false }))
      .then(next => { if (!cancelled) setState(next) })
    return () => { cancelled = true }
  }, [])

  return state
}
