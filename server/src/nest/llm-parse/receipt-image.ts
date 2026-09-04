import { Jimp } from 'jimp';

/**
 * Cap a photographed receipt before it reaches a vision model.
 *
 * A phone photo is around twelve megapixels. Measured against a local Qwen3.5
 * on the same receipt: sent whole (3072x4080) the model answered with nothing
 * at all after thirteen minutes; capped to 1600px it read every line correctly
 * in eight. More pixels is not more legible — past a point it is less.
 *
 * The browser already does this before uploading, which saves the upload too.
 * This is the copy that cannot be skipped: an older client, a browser that
 * could not re-encode, or anything else calling the API directly.
 */

/** Long edge in pixels. A till roll is readable well below this. */
export const RECEIPT_MAX_EDGE = 1600;
/** Enough for small print, far below a camera's default. */
export const RECEIPT_JPEG_QUALITY = 82;

/**
 * The image, no larger than the model needs. Returns the bytes unchanged when
 * they are already small enough, or when the image cannot be read — a scan that
 * might work beats one refused for a resize that failed.
 */
export async function capReceiptImage(
  data: Buffer,
  mimeType: string,
): Promise<{ data: Buffer; mimeType: string }> {
  try {
    const image = await Jimp.read(data);
    if (Math.max(image.width, image.height) <= RECEIPT_MAX_EDGE) return { data, mimeType };
    if (image.width >= image.height) image.resize({ w: RECEIPT_MAX_EDGE });
    else image.resize({ h: RECEIPT_MAX_EDGE });
    const resized = await image.getBuffer('image/jpeg', { quality: RECEIPT_JPEG_QUALITY });
    return { data: Buffer.from(resized), mimeType: 'image/jpeg' };
  } catch {
    return { data, mimeType };
  }
}
