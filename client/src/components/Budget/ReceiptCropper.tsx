import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';

/** A crop box in natural image pixels. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const MIN_SIDE = 40;
/** Hit radius for a corner, in displayed pixels — a thumb is wider than a corner. */
const GRIP = 22;

/**
 * Crop a photographed receipt before it is sent.
 *
 * A phone photo of a till roll is mostly table: the receipt occupies a fraction
 * of the frame, and everything else is detail the model pays for in tokens and
 * can misread — a neighbouring receipt, a menu, a card terminal. Letting the user
 * draw the box around what they actually photographed is the cheapest accuracy
 * win available, and on a small local model it is often the difference between a
 * total being read and not.
 *
 * Deliberately hand-rolled on a canvas rather than pulling in a cropper library:
 * what is needed here is a rectangle with four grips, and the export is one
 * `drawImage` call.
 */
export default function ReceiptCropper({
  file,
  index = 1,
  total = 1,
  onCancel,
  onCropped,
}: {
  file: File;
  /** Which of the batch this is, 1-based, and how many there are. */
  index?: number;
  total?: number;
  onCancel: () => void;
  onCropped: (cropped: File) => void;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [scale, setScale] = useState(1);
  const drag = useRef<{ handle: Handle; startX: number; startY: number; start: Box } | null>(null);

  // Load the photo and start with a box just inside it: a crop the user can
  // accept unchanged is a better default than one they must first create.
  useEffect(() => {
    // Drop the previous box first: with a batch the file changes under a cropper
    // that is already on screen, and the old rectangle may not even fit the new
    // photo. Nothing is drawn until the next image reports its own size.
    setBox(null);
    imageRef.current = null;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      const inset = Math.round(Math.min(img.naturalWidth, img.naturalHeight) * 0.04);
      setBox({
        x: inset,
        y: inset,
        w: img.naturalWidth - inset * 2,
        h: img.naturalHeight - inset * 2,
      });
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !box) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const s = canvas.width / img.naturalWidth;
    const b = { x: box.x * s, y: box.y * s, w: box.w * s, h: box.h * s };

    // Dim what will be discarded, so the kept area reads as the subject.
    ctx.fillStyle = 'rgba(15,23,42,0.55)';
    ctx.fillRect(0, 0, canvas.width, b.y);
    ctx.fillRect(0, b.y + b.h, canvas.width, canvas.height - b.y - b.h);
    ctx.fillRect(0, b.y, b.x, b.h);
    ctx.fillRect(b.x + b.w, b.y, canvas.width - b.x - b.w, b.h);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    ctx.fillStyle = '#ffffff';
    for (const [cx, cy] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h],
    ]) {
      ctx.fillRect(cx - 6, cy - 6, 12, 12);
    }
  }, [box]);

  useEffect(draw, [draw]);

  // Re-fit once, when the image first gets a box — not on every drag of it.
  const fitted = box !== null;

  /** Fit the canvas to its column, capped so a tall receipt stays fully visible. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const available = canvas.parentElement?.clientWidth ?? 320;
    const width = Math.min(available, 520);
    const s = width / img.naturalWidth;
    canvas.width = width;
    canvas.height = Math.round(img.naturalHeight * s);
    setScale(s);
    draw();
  }, [fitted, draw]);

  const pointAt = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const handleAt = (p: { x: number; y: number }, b: Box): Handle => {
    const near = GRIP / scale;
    const corners: [Handle, number, number][] = [
      ['nw', b.x, b.y],
      ['ne', b.x + b.w, b.y],
      ['sw', b.x, b.y + b.h],
      ['se', b.x + b.w, b.y + b.h],
    ];
    for (const [name, cx, cy] of corners) {
      if (Math.abs(p.x - cx) < near && Math.abs(p.y - cy) < near) return name;
    }
    return 'move';
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!box) return;
    const p = pointAt(e);
    drag.current = { handle: handleAt(p, box), startX: p.x, startY: p.y, start: { ...box } };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const img = imageRef.current;
    if (!d || !img || !box) return;
    const p = pointAt(e);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const s = d.start;

    let next: Box;
    if (d.handle === 'move') {
      next = {
        ...s,
        x: Math.min(Math.max(0, s.x + dx), W - s.w),
        y: Math.min(Math.max(0, s.y + dy), H - s.h),
      };
    } else {
      const right = s.x + s.w;
      const bottom = s.y + s.h;
      const west = d.handle === 'nw' || d.handle === 'sw';
      const north = d.handle === 'nw' || d.handle === 'ne';
      const x = west ? Math.min(Math.max(0, s.x + dx), right - MIN_SIDE) : s.x;
      const y = north ? Math.min(Math.max(0, s.y + dy), bottom - MIN_SIDE) : s.y;
      const w = west ? right - x : Math.min(W - s.x, Math.max(MIN_SIDE, s.w + dx));
      const h = north ? bottom - y : Math.min(H - s.y, Math.max(MIN_SIDE, s.h + dy));
      next = { x, y, w, h };
    }
    setBox(next);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const apply = () => {
    const img = imageRef.current;
    // No image on screen means nothing to crop against — the frame never loaded.
    // Sending the original on is the same call the export failure makes below:
    // cropping improves the upload, it is never a precondition for it. Returning
    // nothing here left the button inert and the user stuck on this step.
    if (!img || !box) return onCropped(file);
    const out = document.createElement('canvas');
    out.width = Math.round(box.w);
    out.height = Math.round(box.h);
    const ctx = out.getContext('2d');
    if (!ctx) return onCropped(file);
    ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);
    out.toBlob(
      (blob) => {
        // A canvas that refuses to export leaves the original — cropping is an
        // improvement on the upload, never a precondition for it.
        onCropped(blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file);
      },
      'image/jpeg',
      0.92
    );
  };

  const btn = {
    padding: '9px 15px',
    borderRadius: 10,
    fontSize: 'calc(13px * var(--fs-scale-body, 1))',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
        <p className="text-content-faint" style={{ fontSize: 'calc(12.5px * var(--fs-scale-caption, 1))', margin: 0 }}>
          {t('receipts.cropHint')}
        </p>
        {total > 1 && (
          <span
            className="text-content-muted"
            style={{ fontSize: 'calc(12px * var(--fs-scale-caption, 1))', fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            {t('receipts.cropProgress', { index, total })}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ maxWidth: '100%', borderRadius: 10, touchAction: 'none', cursor: 'crosshair' }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} className="border border-edge bg-surface-secondary text-content" style={btn}>
          {t('receipts.retakePhoto')}
        </button>
        <button type="button" onClick={apply} className="bg-[var(--text-primary)] text-[var(--bg-primary)]" style={{ ...btn, border: 0 }}>
          {t('receipts.cropApply')}
        </button>
      </div>
    </div>
  );
}
