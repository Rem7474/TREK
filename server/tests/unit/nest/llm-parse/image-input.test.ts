import { describe, it, expect } from 'vitest';
import { Jimp } from 'jimp';
import { capImage, imageMimeType, IMAGE_MAX_EDGE, renderPdfPages } from '../../../../src/nest/llm-parse/image-input';

async function png(w: number, h: number): Promise<Buffer> {
  const image = new Jimp({ width: w, height: h, color: 0xffffffff });
  return Buffer.from(await image.getBuffer('image/png'));
}

describe('imageMimeType', () => {
  it('knows the photo formats a provider reads, whatever the case', () => {
    expect(imageMimeType('a.jpg')).toBe('image/jpeg');
    expect(imageMimeType('A.JPEG')).toBe('image/jpeg');
    expect(imageMimeType('a.png')).toBe('image/png');
    expect(imageMimeType('a.webp')).toBe('image/webp');
  });

  it('is null for everything else, HEIC included', () => {
    for (const name of ['a.heic', 'a.pdf', 'a.txt', 'jpg', 'a.jpg.pdf']) expect(imageMimeType(name)).toBeNull();
  });
});

describe('capImage', () => {
  it('shrinks the long edge of a large photo to the cap, as a JPEG', async () => {
    const out = await capImage(await png(IMAGE_MAX_EDGE * 2, 1000), 'image/png');
    expect(out.mimeType).toBe('image/jpeg');
    const back = await Jimp.read(out.data);
    expect(back.width).toBe(IMAGE_MAX_EDGE);
    expect(back.height).toBe(500);
  });

  it('caps a portrait photo by its height', async () => {
    const back = await Jimp.read((await capImage(await png(800, IMAGE_MAX_EDGE * 2), 'image/png')).data);
    expect(back.height).toBe(IMAGE_MAX_EDGE);
    expect(back.width).toBe(400);
  });

  it('leaves a photo that is already small enough untouched', async () => {
    const data = await png(400, 300);
    expect(await capImage(data, 'image/png')).toEqual({ data, mimeType: 'image/png' });
  });

  it('passes bytes it cannot decode through unchanged', async () => {
    const data = Buffer.from('RIFF....WEBP');
    expect(await capImage(data, 'image/webp')).toEqual({ data, mimeType: 'image/webp' });
  });
});

/** A PDF with no text layer: each page is one JPEG, as a scanner writes it. */
async function scannedPdf(pages: number): Promise<Buffer> {
  const jpg = Buffer.from(await new Jimp({ width: 300, height: 400, color: 0xddddddff }).getBuffer('image/jpeg'));
  const objects: Buffer[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
  objects.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`));
  for (let i = 0; i < pages; i++) {
    const page = 3 + i * 3;
    const content = 'q 300 0 0 400 0 0 cm /Im0 Do Q';
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    objects.push(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 300 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),
      jpg,
      Buffer.from('\nendstream'),
    ]));
  }
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    parts.push(obj);
    length += obj.length;
  });
  const rows = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe('renderPdfPages', () => {
  it('draws the first two pages of a scan as images no larger than a capped photo', async () => {
    const pages = await renderPdfPages(await scannedPdf(3));
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const image = await Jimp.read(page.data);
      expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(IMAGE_MAX_EDGE);
    }
  }, 30_000);

  it('throws for bytes that are not a PDF, which the caller reports as unreadable', async () => {
    await expect(renderPdfPages(Buffer.from('not a pdf'))).rejects.toThrow();
  });
});
