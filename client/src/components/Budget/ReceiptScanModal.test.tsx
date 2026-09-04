// FE-COMP-RECEIPTS: scan a receipt into an expense (Costs → Scan receipt)
import { http, HttpResponse } from 'msw';
import { server } from '../../../tests/helpers/msw/server';
import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render';
import ReceiptScanModal from './ReceiptScanModal';
import type { ReceiptConfirmRequest } from '@trek/shared';
import { receiptsApi } from '../../api/client';
import { useBackgroundTasksStore } from '../../store/backgroundTasksStore';

const people = [
  { id: 1, username: 'alice', avatar_url: null },
  { id: 2, username: 'bob', avatar_url: null },
];

const mealItem = {
  doc_type: 'meal',
  category: 'food',
  title: 'Chez Marcel',
  merchant: 'Chez Marcel',
  date: '2026-06-11',
  time: '20:15',
  total: 86.4,
  currency: 'EUR',
  needs_review: false,
  source: { fileName: 'receipt.jpg', index: 0 },
};

const hotelItem = {
  ...mealItem,
  doc_type: 'accommodation',
  category: 'accommodation',
  title: 'Hotel Napoleon',
  merchant: 'Hotel Napoleon',
  total: 420,
  check_in: '2026-06-11T15:00:00',
  check_out: '2026-06-14T11:00:00',
};

/**
 * The scan is a background job: the upload answers with an id and the result is
 * fetched (or pushed) afterwards. These two handlers stand in for both halves.
 */
function scanJob(result: unknown, status: 'done' | 'error' = 'done', error?: string) {
  return [
    http.post('/api/trips/1/receipts/scan/async', () => HttpResponse.json({ jobId: 'job-1' })),
    http.get('/api/trips/1/receipts/scan/jobs/job-1', () =>
      HttpResponse.json({ status, done: 1, total: 1, result, error })
    ),
  ];
}

/**
 * Open the panel on a finished scan, the way the background widget does. The
 * reading is a background job now, so the review is reached by reopening with a
 * result — not by waiting inside the modal.
 */
function renderReview(result: unknown, props: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const utils = render(
    <ReceiptScanModal
      tripId={1}
      base="EUR"
      people={people}
      me={1}
      initialResult={result as never}
      onClose={vi.fn()}
      onSaved={onSaved}
      {...props}
    />
  );
  return { ...utils, onSaved };
}

function renderModal(onSaved = vi.fn()) {
  const utils = render(
    <ReceiptScanModal tripId={1} base="EUR" people={people} me={1} onClose={vi.fn()} onSaved={onSaved} />
  );
  return { ...utils, onSaved };
}

/**
 * Stand in for a browser that can decode and re-encode a photo. jsdom has
 * neither, and without them every image would be handed on untouched — which is
 * the fallback, not the path worth testing.
 */
function withImageDecoder(width = 1200, height = 1600) {
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width, height }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    cb: BlobCallback
  ) {
    cb(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
  } as never);
}

/** Drop a file on the hidden input and run the scan. */
async function scan(container: HTMLElement, name = 'receipt.jpg') {
  const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], name, { type: 'image/jpeg' })] } });
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup();
  // A picked photo is re-encoded before it counts as chosen, so the action only
  // arms once that has landed — the same wait the button makes the user do.
  const action = await screen.findByRole('button', { name: 'Scan' });
  await waitFor(() => expect(action).not.toBeDisabled());
  await user.click(action);
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReceiptScanModal', () => {
  it('scans an uploaded receipt and shows the detected expense for review', async () => {
    renderReview({ scanId: 's1', items: [mealItem], warnings: [], files: [] });

    expect(await screen.findByDisplayValue('Chez Marcel')).toBeInTheDocument();
    expect(screen.getByDisplayValue('86.4')).toBeInTheDocument();
    expect(screen.getByText('Meal')).toBeInTheDocument();
    expect(screen.getByText('Food & drink')).toBeInTheDocument();
  });

  it('opens the camera rather than the file picker when taking a photo', async () => {
    const { container } = renderModal();

    const inputs = Array.from(container.ownerDocument.querySelectorAll('input[type="file"]'));
    const camera = inputs.find((i) => i.hasAttribute('capture')) as HTMLInputElement;

    // `capture="environment"` is what makes a phone open the rear camera straight
    // away instead of the gallery — the primary way a receipt gets in.
    expect(camera).toBeTruthy();
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.getAttribute('accept')).toBe('image/*');

    const clicked = vi.spyOn(camera, 'click');
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: /Take a photo/i }));
    expect(clicked).toHaveBeenCalled();
  });






  it('sends a mixed selection whole — photo and PDF alike', async () => {
    let uploaded = 0;
    server.use(
      http.post('/api/trips/1/receipts/scan/async', async ({ request }) => {
        const form = await request.formData();
        uploaded = form.getAll('files').length;
        return HttpResponse.json({ jobId: 'job-mixed' });
      })
    );
    const { container } = renderModal();
    const picker = container.ownerDocument.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;

    fireEvent.change(picker, {
      target: {
        files: [
          new File(['a'], 'photo.jpg', { type: 'image/jpeg' }),
          new File(['b'], 'invoice.pdf', { type: 'application/pdf' }),
        ],
      },
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const action = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(action).not.toBeDisabled());
    await user.click(action);

    await waitFor(() => expect(uploaded).toBe(2));
    const task = useBackgroundTasksStore.getState().tasks.find((t) => t.id === 'job-mixed');
    expect(task?.label).toBe('photo.jpg, invoice.pdf');
  });


  it('sends the photo the camera returned to the background scanner', async () => {
    let uploaded = 0;
    server.use(
      http.post('/api/trips/1/receipts/scan/async', () => {
        uploaded += 1;
        return HttpResponse.json({ jobId: 'job-heic' });
      })
    );
    const onClose = vi.fn();
    const { container } = render(
      <ReceiptScanModal tripId={1} base="EUR" people={people} me={1} onClose={onClose} onSaved={vi.fn()} />
    );

    withImageDecoder();
    const picker = container.ownerDocument.querySelector('input[type="file"]:not([capture])') as HTMLInputElement;
    fireEvent.change(picker, {
      target: { files: [new File(['x'], 'IMG_0421.HEIC', { type: 'image/heic' })] },
    });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const action = await screen.findByRole('button', { name: 'Scan' });
    await waitFor(() => expect(action).not.toBeDisabled());
    await user.click(action);

    await waitFor(() => expect(uploaded).toBe(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('saves the reviewed receipt as an expense paid by me and split with everyone', async () => {
    let posted: ReceiptConfirmRequest | null = null;
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest;
        return HttpResponse.json({ created: [{ budget_item: { id: 5 } }], warnings: [] });
      })
    );
    const { onSaved } = renderReview({ scanId: 's1', items: [mealItem], warnings: [], files: [] });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Save expense' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.scanId).toBe('s1');
    expect(posted.items[0]).toMatchObject({
      title: 'Chez Marcel',
      total: 86.4,
      category: 'food',
      payers: [{ user_id: 1, amount: 86.4 }],
      member_ids: [1, 2],
      attach_receipt: true,
    });
    // A meal is money already spent — nothing to add to the itinerary by default.
    expect(posted.items[0].create_reservation).toBe(false);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('reviews the split with the same editor as a typed expense: several payers and a note', async () => {
    let posted: ReceiptConfirmRequest | null = null;
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest;
        return HttpResponse.json({ created: [{ budget_item: { id: 8 } }], warnings: [] });
      })
    );
    renderReview({ scanId: 's1', items: [mealItem], warnings: [], files: [] });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Multiple people paid' }));
    // Enabling it seeds only the scanner; Bob is added the same way as in Costs.
    await user.click(screen.getAllByTestId('payer-toggle')[1]);
    await user.type(screen.getByLabelText('Note'), 'split with Bob');
    await user.click(screen.getByRole('button', { name: 'Save expense' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.items[0].payers).toEqual([
      { user_id: 1, amount: 43.2 },
      { user_id: 2, amount: 43.2 },
    ]);
    expect(posted.items[0].note).toBe('split with Bob');
    // Nobody typed a per-head amount, so the shares stay an equal split.
    expect(posted.items[0].members).toEqual([
      { user_id: 1, amount: null },
      { user_id: 2, amount: null },
    ]);
  });

  it('splits a receipt line by line, with the lines the scan read already in place', async () => {
    let posted: ReceiptConfirmRequest | null = null;
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest;
        return HttpResponse.json({ created: [{ budget_item: { id: 9 } }], warnings: [] });
      })
    );
    renderReview({
      scanId: 's1',
      items: [{ ...mealItem, line_items: [{ name: 'Pasta', price: 40 }, { name: 'Wine', price: 46.4 }] }],
      warnings: [],
      files: [],
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    // The lines are the finest split the document supports, so the review opens
    // on them rather than making the user find the mode.
    expect(await screen.findByDisplayValue('Pasta')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(JSON.parse(posted.items[0].ticket_json as string)).toEqual({
      items: [
        { name: 'Pasta', price: '40', parts: [1, 2] },
        { name: 'Wine', price: '46.4', parts: [1, 2] },
      ],
    });
    expect(posted.items[0].total).toBe(86.4);
  });

  it('offers to add a hotel receipt to the itinerary, checked by default', async () => {
    let posted: ReceiptConfirmRequest | null = null;
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest;
        return HttpResponse.json({ created: [{ budget_item: { id: 6 } }], warnings: [] });
      })
    );
    renderReview({ scanId: 's1', items: [hotelItem], warnings: [], files: [] });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const toggle = await screen.findByRole('checkbox', { name: /Also add it to the itinerary/ });
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Save expense' }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.items[0]).toMatchObject({ create_reservation: true, category: 'accommodation' });
  });

  it('lets the user drop the booking before saving', async () => {
    let posted: ReceiptConfirmRequest | null = null;
    server.use(
      http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
        posted = (await request.json()) as ReceiptConfirmRequest;
        return HttpResponse.json({ created: [{ budget_item: { id: 7 } }], warnings: [] });
      })
    );
    renderReview({ scanId: 's1', items: [hotelItem], warnings: [], files: [] });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('checkbox', { name: /Also add it to the itinerary/ }));
    await user.click(screen.getByRole('button', { name: 'Save expense' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted.items[0].create_reservation).toBe(false);
  });

  describe('opened from the planner (intent="booking")', () => {

    it('reviews the itinerary entry before the money', async () => {
      renderReview({ scanId: 's1', items: [hotelItem], warnings: [], files: [] }, { intent: 'booking' });

      await screen.findByDisplayValue('Hotel Napoleon');
      // The modal renders through a portal, so the card lives on document.body.
      const text = document.body.textContent ?? '';
      // From Transport the booking is what the user came for, so it is read first.
      expect(text.indexOf('itinerary')).toBeGreaterThan(-1);
      expect(text.indexOf('itinerary')).toBeLessThan(text.indexOf('paid'));
    });

    it('ticks the itinerary box even for a type that would not add one from Costs', async () => {
      // A meal never creates a booking by default in Costs; asked for from the
      // planner, the user plainly wants the itinerary entry.
      renderReview({ scanId: 's1', items: [mealItem], warnings: [], files: [] }, { intent: 'booking' });

      await screen.findByDisplayValue('Chez Marcel');
      const boxes = Array.from(document.body.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes[0].checked).toBe(true);
    });

    it('still creates the expense alongside the booking', async () => {
      let posted: ReceiptConfirmRequest | null = null;
      server.use(
        http.post('/api/trips/1/receipts/confirm', async ({ request }) => {
          posted = (await request.json()) as ReceiptConfirmRequest;
          return HttpResponse.json({ created: [], warnings: [] });
        })
      );
      renderReview({ scanId: 's1', items: [hotelItem], warnings: [], files: [] }, { intent: 'booking' });
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      await screen.findByDisplayValue('Hotel Napoleon');
      await user.click(screen.getByRole('button', { name: /Save expense/i }));

      await waitFor(() => expect(posted).not.toBeNull());
      expect(posted!.items[0].total).toBe(420);
      expect(posted!.items[0].create_reservation).toBe(true);
    });
  });

  it('explains that the AI addon is required when the server returns 409', async () => {
    server.use(
      http.post('/api/trips/1/receipts/scan/async', () =>
        HttpResponse.json({ error: 'AI parsing is not configured' }, { status: 409 })
      )
    );
    const { container } = renderModal();
    await scan(container);

    expect(await screen.findByText(/needs the AI parsing addon/)).toBeInTheDocument();
  });

  it('reports back when nothing readable was found', async () => {
    renderReview({ scanId: 's1', items: [], warnings: ['receipt.jpg: no receipt found'], files: [] });

    expect(await screen.findByText('receipt.jpg: no receipt found')).toBeInTheDocument();
  });

  it('says a provider refusal in the reader\'s language, not the server\'s English', async () => {
    // The server sends both: a code for the panel to translate, and its English
    // sentence for the log and for a locale TREK does not ship.
    renderReview({
      scanId: 's1',
      items: [],
      warnings: ['receipt.jpg: scan failed — the configured AI model cannot read images'],
      files: [{ fileName: 'receipt.jpg', items: 0, failureCode: 'noVision' }],
    });

    expect(await screen.findByText(/cannot read images/i)).toBeInTheDocument();
    // The raw server line is replaced, not appended.
    expect(screen.queryByText(/scan failed —/)).not.toBeInTheDocument();
  });

  it('falls back to the server line when the failure carries no code', async () => {
    renderReview({
      scanId: 's1',
      items: [],
      warnings: ['receipt.jpg: no receipt found'],
      files: [{ fileName: 'receipt.jpg', items: 0 }],
    });

    expect(await screen.findByText('receipt.jpg: no receipt found')).toBeInTheDocument();
  });

  it('hands the wait to the background widget instead of holding the panel open', async () => {
    server.use(http.post('/api/trips/1/receipts/scan/async', () => HttpResponse.json({ jobId: 'job-9' })));
    const onClose = vi.fn();
    const { container } = render(
      <ReceiptScanModal tripId={1} base="EUR" people={people} me={1} onClose={onClose} onSaved={vi.fn()} />
    );

    await scan(container);

    // Reading a photograph takes minutes; the user should not be pinned to this
    // screen watching a spinner while it happens.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const task = useBackgroundTasksStore.getState().tasks.find((t) => t.id === 'job-9');
    expect(task).toMatchObject({ job: 'receipt', status: 'running', tripId: '1' });
  });

  it('reopens straight on the review when the widget hands back a finished scan', async () => {
    render(
      <ReceiptScanModal
        tripId={1}
        base="EUR"
        people={people}
        me={1}
        initialResult={{ scanId: 's9', items: [mealItem], warnings: [], files: [] } as never}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    // The reading already happened — do not ask for the file again.
    expect(await screen.findByDisplayValue('Chez Marcel')).toBeInTheDocument();
  });

  it('uploads a phone photo as a JPEG the model can actually read', async () => {
    withImageDecoder(4032, 3024)
    const sent = vi.spyOn(receiptsApi, 'scanAsync')
    server.use(...scanJob({ scanId: 's1', items: [], warnings: [], files: [] }))

    const { container } = renderModal()
    await scan(container, 'IMG_0042.HEIC')

    await waitFor(() => expect(sent).toHaveBeenCalled())
    // The HEIC no provider reads left as the JPEG they all do.
    const [, files] = sent.mock.calls[0]
    expect(files[0].name).toBe('IMG_0042.jpg')
    expect(files[0].type).toBe('image/jpeg')
  })

  it('refuses a photo the browser cannot re-encode instead of burning a scan on it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('unsupported')))

    const { container } = renderModal()
    const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'IMG_0042.HEIC', { type: 'image/heic' })] } })

    // The format is settled when the bytes are read, not from the extension.
    expect(await screen.findByText('That file type cannot be scanned.')).toBeInTheDocument()
  })

  it('sends the quick read only when it is asked for', async () => {
    // It gives up the receipt's own lines, and with them the per-item split, so
    // it is never the default — the user has to say so.
    withImageDecoder()
    const sent = vi.spyOn(receiptsApi, 'scanAsync')
    server.use(...scanJob({ scanId: 's1', items: [], warnings: [], files: [] }))

    const { container } = renderModal()
    const { default: userEvent } = await import('@testing-library/user-event')
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: /Quick read/i }))
    await scan(container, 'receipt.jpg')

    await waitFor(() => expect(sent).toHaveBeenCalled())
    expect(sent.mock.calls[0][2]).toBe(true)
  })

  it('rejects a file type that cannot hold a receipt', async () => {
    const { container } = renderModal();
    const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'holiday.mp4', { type: 'video/mp4' })] } });

    expect(await screen.findByText('That file type cannot be scanned.')).toBeInTheDocument();
  });
});
