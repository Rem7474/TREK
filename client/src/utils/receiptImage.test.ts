// FE-UTIL-RECEIPTIMG: shrink and re-encode a photographed receipt before upload
import { isProviderSafeImage, normalizeReceiptImage, RECEIPT_MAX_EDGE } from './receiptImage'

/** Pretend the browser can decode `file` into an image of this size. */
function withDecoder(width: number, height: number) {
  const bitmap = { width, height, close: vi.fn() }
  const decode = vi.fn().mockResolvedValue(bitmap)
  vi.stubGlobal('createImageBitmap', decode)
  return decode
}

/** Canvas export, which jsdom does not implement. */
function withCanvas() {
  const drawImage = vi.fn()
  const sizes: { width: number; height: number }[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback,
  ) {
    sizes.push({ width: this.width, height: this.height })
    cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }))
  } as never)
  return { drawImage, sizes }
}

const file = (name: string, type: string, bytes = 'x') => new File([bytes], name, { type })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('normalizeReceiptImage', () => {
  it('leaves a document alone — only photographs need re-encoding', async () => {
    const pdf = file('ticket.pdf', 'application/pdf')
    expect(await normalizeReceiptImage(pdf)).toBe(pdf)
  })

  it('turns an iPhone HEIC into a JPEG, which is all a vision provider accepts', async () => {
    withDecoder(900, 1200)
    withCanvas()

    const out = await normalizeReceiptImage(file('IMG_0042.HEIC', 'image/heic'))

    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('IMG_0042.jpg')
    expect(isProviderSafeImage(out)).toBe(true)
  })

  it('caps the long edge, whichever way the receipt was shot', async () => {
    withDecoder(4032, 3024)
    const { sizes } = withCanvas()

    await normalizeReceiptImage(file('receipt.jpg', 'image/jpeg'))

    expect(sizes[0].width).toBe(RECEIPT_MAX_EDGE)
    expect(sizes[0].height).toBe(1200) // 3024 * (1600/4032)
  })

  it('passes an already-small JPEG through rather than re-encoding it twice', async () => {
    withDecoder(800, 600)
    withCanvas()

    const small = file('receipt.jpg', 'image/jpeg')
    expect(await normalizeReceiptImage(small)).toBe(small)
  })

  it('hands back the original when the browser cannot decode it, so the caller can refuse it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))

    const heic = file('IMG_0042.HEIC', 'image/heic')
    const out = await normalizeReceiptImage(heic)

    expect(out).toBe(heic)
    expect(isProviderSafeImage(out)).toBe(false)
  })

  it('never loses the receipt on a browser with no image decoding at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined)

    const jpg = file('receipt.jpg', 'image/jpeg')
    expect(await normalizeReceiptImage(jpg)).toBe(jpg)
  })
})
