/**
 * Re-encode a photographed receipt before it leaves the browser.
 *
 * Two things went wrong without this. A phone photo picked from an iPhone's
 * gallery is HEIC, and no vision provider TREK talks to accepts HEIC — the scan
 * spent minutes reaching a refusal. And a 12-megapixel photo was uploaded whole
 * and handed to the model whole: a receipt is legible long before that, while
 * the pixels cost upload time, context and inference time.
 *
 * So: decode once, cap the long edge, write a JPEG. The decode is also what
 * settles the format question — whatever the browser can display becomes a JPEG,
 * and whatever it cannot is refused here rather than five minutes later.
 *
 * Everything degrades to the original file: a browser without `createImageBitmap`
 * or canvas export (jsdom, an old WebView) must not lose the user their receipt.
 */

/** Long-edge cap. A till roll is readable well below this; the model pays for the rest. */
export const RECEIPT_MAX_EDGE = 1600
/** Enough for small print, far below a camera's default. */
export const RECEIPT_JPEG_QUALITY = 0.82

/** Formats every vision provider accepts, so an already-small one can pass untouched. */
const PROVIDER_SAFE = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** True when the browser gave us something a provider would reject outright. */
export function isProviderSafeImage(file: File): boolean {
  return PROVIDER_SAFE.has(file.type)
}

async function decode(file: File): Promise<{ width: number; height: number; draw: CanvasImageSource } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      // from-image applies the EXIF rotation, which phones rely on — without it a
      // receipt shot in portrait reaches the model on its side.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { width: bitmap.width, height: bitmap.height, draw: bitmap }
    } catch {
      return null
    }
  }
  return null
}

/**
 * A JPEG no larger than the model needs, or the original when the browser cannot
 * re-encode it. Non-images (PDF, .eml) are returned untouched.
 */
export async function normalizeReceiptImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file

  const decoded = await decode(file)
  if (!decoded) return file

  const { width, height, draw } = decoded
  const scale = Math.min(1, RECEIPT_MAX_EDGE / Math.max(width, height))
  // Already small and already a format providers take: nothing to gain by
  // re-encoding, and a second JPEG pass only adds artefacts.
  if (scale === 1 && isProviderSafeImage(file)) return file

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx || typeof canvas.toBlob !== 'function') return file
  ctx.drawImage(draw, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/jpeg', RECEIPT_JPEG_QUALITY)
    } catch {
      resolve(null)
    }
  })
  if (!blob) return file

  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
  return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified })
}
