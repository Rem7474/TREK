import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { capReceiptImage, RECEIPT_MAX_EDGE } from '../../../../src/nest/llm-parse/receipt-image';

async function jpeg(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0xffffffff });
  return Buffer.from(await image.getBuffer('image/jpeg', { quality: 90 }));
}

async function sizeOf(data: Buffer): Promise<{ width: number; height: number }> {
  const image = await Jimp.read(data);
  return { width: image.width, height: image.height };
}

describe('capReceiptImage', () => {
  it('caps a portrait phone photo by its long edge, keeping the shape', async () => {
    // Sent whole, the same receipt came back empty from the model; capped, every
    // line was read. More pixels is not more legible.
    const out = await capReceiptImage(await jpeg(1536, 2040), 'image/jpeg');

    expect(await sizeOf(out.data)).toEqual({ width: 1205, height: RECEIPT_MAX_EDGE });
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('caps a landscape one by its width', async () => {
    const out = await capReceiptImage(await jpeg(2400, 1200), 'image/jpeg');
    expect(await sizeOf(out.data)).toEqual({ width: RECEIPT_MAX_EDGE, height: 800 });
  });

  it('leaves an already-small image untouched, rather than re-encoding it twice', async () => {
    // The browser normally caps it before uploading; doing it again would only
    // add JPEG artefacts to what is already the right size.
    const small = await jpeg(800, 1000);
    const out = await capReceiptImage(small, 'image/jpeg');
    expect(out.data).toBe(small);
  });

  it('hands back what it was given when the bytes cannot be read', async () => {
    // A scan that might still work beats one refused because a resize failed.
    const notAnImage = Buffer.from('nonsense');
    const out = await capReceiptImage(notAnImage, 'image/heic');
    expect(out).toEqual({ data: notAnImage, mimeType: 'image/heic' });
  });
});
