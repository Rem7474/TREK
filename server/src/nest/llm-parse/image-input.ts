import { extname } from 'node:path';
import { Jimp } from 'jimp';
import { PDFParse } from 'pdf-parse';
import { LLM_PHOTO_EXTENSIONS } from '@trek/shared';

/** A photographed document on its way to a vision model, by the extensions shared/ lists. */
const IMAGE_MIME_BY_EXT: Record<(typeof LLM_PHOTO_EXTENSIONS)[number], string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export const IMAGE_EXTENSIONS: readonly string[] = LLM_PHOTO_EXTENSIONS;

/** The image MIME type for a file name, or null when it is not a photo TREK sends. */
export function imageMimeType(fileName: string): string | null {
  return (IMAGE_MIME_BY_EXT as Record<string, string>)[extname(fileName).toLowerCase()] ?? null;
}

/**
 * Long edge in pixels. A phone photo is around twelve megapixels, which a model
 * pays for in prompt tokens without reading the print any better: the same
 * receipt on a local qwen3.5:4b took 252s whole and 37-124s at this size.
 */
export const IMAGE_MAX_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 82;

/**
 * The image, no larger than the model needs. Returns the bytes unchanged when
 * they are already small enough, or when they cannot be decoded (Jimp has no
 * WebP): a photo that might be read beats one refused over a failed resize.
 */
export async function capImage(data: Buffer, mimeType: string): Promise<{ data: Buffer; mimeType: string }> {
  try {
    const image = await Jimp.read(data);
    if (Math.max(image.width, image.height) <= IMAGE_MAX_EDGE) return { data, mimeType };
    if (image.width >= image.height) image.resize({ w: IMAGE_MAX_EDGE });
    else image.resize({ h: IMAGE_MAX_EDGE });
    const resized = await image.getBuffer('image/jpeg', { quality: IMAGE_JPEG_QUALITY });
    return { data: Buffer.from(resized), mimeType: 'image/jpeg' };
  } catch {
    return { data, mimeType };
  }
}

/**
 * Pages of a PDF read the only way a scan can be: as pictures. The booking
 * details sit on the first pages, and every page costs the model a photo's
 * worth of prompt, so only the first two are drawn.
 */
export const PDF_PAGES_AS_IMAGES = 2;

/** The first pages of a PDF drawn as images, capped like a photo; empty when none could be drawn. */
export async function renderPdfPages(data: Buffer): Promise<{ data: Buffer; mimeType: string }[]> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const shot = await parser.getScreenshot({ first: PDF_PAGES_AS_IMAGES, desiredWidth: IMAGE_MAX_EDGE, imageBuffer: true, imageDataUrl: false });
    const pages: { data: Buffer; mimeType: string }[] = [];
    for (const page of shot.pages) {
      if (page.data?.length) pages.push(await capImage(Buffer.from(page.data), 'image/png'));
    }
    return pages;
  } finally {
    await parser.destroy().catch(() => {});
  }
}
