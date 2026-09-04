# Receipt Scanning

Photograph a receipt and TREK turns it into an expense. The **AI Parsing** addon reads the image, works out what kind of document it is — a meal, a hotel folio, a train ticket — and pre-fills the [expense](Budget-Tracking) with the merchant, the date, the amount and the currency. You check the result and save.

For a stay or a journey it goes one step further: the same receipt also creates the matching [reservation](Reservations-and-Bookings) with its place, dates and route. The photo itself is filed in [Documents](Documents-and-Files) alongside the expense.

> **Admin:** Receipt scanning needs both the **Costs** and the **AI Parsing** addons enabled in [Admin-Addons](Admin-Addons). Without them, the *Scan receipt* button is not shown.

## How it differs from booking import

[AI Booking Import](AI-Booking-Import) reads a *booking* — something that has not happened yet — and puts it on the itinerary. Receipt scanning reads a *payment* — something already spent — and puts it in Costs.

They also differ in what they can read. Booking import parses structured confirmations with KDE Itinerary first and only falls back to the model. A photographed till roll has no structure and no text layer, so there is no non-AI path: receipt scanning always goes to the model, which is why it needs the addon.

| | AI Booking Import | Receipt Scanning |
|---|---|---|
| Input | EML, PDF, PKPass, HTML, TXT | **Photos** (JPG, PNG, HEIC, WEBP), PDF, TXT, HTML, EML |
| Reads | Booking confirmations | Receipts, bills, invoices |
| Creates | Reservation (+ linked cost) | Expense (+ optional reservation and document) |
| Needs AI addon | Only as a fallback | Always |

## Scanning a receipt

1. Open a trip → **Costs**.
2. Click **Scan receipt** (on a phone, the camera button next to *Add expense*). The picker your device offers already has Camera beside Files, so photographing a bill and opening a saved invoice are the same gesture.
3. Pick up to 5 files at once, 10 MB each. Photos are shrunk and re-encoded in the browser before they are uploaded — a phone photo is far larger than the model needs.
4. **Crop** each photo to the receipt. Dragging the corners in is worth doing: a frame that is mostly table costs reading time and invites misreads. A batch is cropped one image after the other.
5. Reading starts in the background. The scan appears in the **background tasks** tray, and you can leave the panel, change tab or lock the phone — when it is done the tray offers **Review**.

### Quick read

**Quick read** asks for the amount, the merchant, the date and the currency, and nothing else. What it gives up is the receipt's own itemized lines — and with them the per-item split — plus the address and the reference number. For a coffee or a parking meter there is nothing there to give up; for a shared restaurant table there is.

It is worth measuring on your own hardware before reaching for it. With reasoning turned off on the native Ollama transport, the full read of one restaurant bill took about 25 seconds on `qwen3.5:4b` — the shorter prompt saves less than it did when reasoning was still eating the token budget.

### How long it takes

A cloud provider answers in seconds. A local model on CPU takes minutes on a photograph, which is why the scan is a background job rather than something you wait on: nothing in the browser holds the request open, and a proxy timeout can no longer lose the work. Scans queue one at a time per user — two inferences at once on one CPU is slower than the same two in a row.

## The review step

Nothing is saved until you confirm. Each scanned receipt appears as a card showing what was detected:

- **Document type** — meal, groceries, accommodation, transport, flight, fuel, activity, shopping, health, fees or other. Changing it re-picks the Costs category and the itinerary toggle.
- **Also add it to the itinerary** — see below.
- **Category** — the Costs category the expense will land in.
- **Merchant** — becomes the expense name.
- **Amount, currency, day** — a foreign-currency receipt shows the converted amount underneath, and its exchange rate is frozen at save time so a later rate change never re-opens a settled balance.
- **Who paid** and **Split between** — defaults to *you paid, split with everyone*, exactly like a hand-entered expense.
- **Keep the receipt in Documents** — files the photo/PDF in the trip's documents, linked to the expense (and to the booking, when one is created).

A card marked **Check this one** is missing something the scan could not read — usually the merchant or the date. The expense is still perfectly usable; the badge just tells you where to look.

Anything the scan gets wrong is editable here, and the expense stays fully editable afterwards.

## Where you can start a scan

Two entry points, same scanner, different emphasis:

- **Costs → Scan receipt** — the money is the point. The expense is reviewed first, and *Also add it to the itinerary* is offered (ticked for a stay, a journey or a flight).
- **Transport / Bookings → the import button** — the booking is the point. The itinerary entry is reviewed first and ticked by default whatever the document turns out to be, and the expense is still created underneath it. It is one button: the OS picker offers Camera beside Files, and a photo goes to the scanner while a confirmation goes to [AI Booking Import](AI-Booking-Import).

Either way one scan produces one expense, plus the booking when you keep it ticked. Starting from Transport does not skip the expense: a ticket you photographed is a ticket you paid for.

## What lands on the itinerary

Some receipts document something that belongs on the plan, not just in the ledger. When they do, **Also add it to the itinerary** appears, and it is **on by default** for a stay or a journey:

| Document type | Reservation created | On by default |
|---|---|---|
| Accommodation | Hotel (+ accommodation dates on the day plan, geocoded place) | Yes |
| Transport | Train, bus, taxi, ferry, transit or car — narrowed from the operator named on the ticket, with From → To endpoints | Yes |
| Flight | Flight | Yes |
| Meal | Restaurant | No |
| Activity | Event | No |
| Groceries, shopping, fuel, health, fees, other | — | — |

The created booking is marked **confirmed** (the receipt is the proof), carries the amount in its metadata, and is linked to the expense — so editing the price on either side keeps the other in step.

Creating a booking needs the **reservation edit** permission. Without it the expense is still created, and a note tells you the booking was skipped.

## Itemized receipts

When the model can read the individual lines of a bill, they are stored on the expense in the *Ticket* split format. Reopen the expense and switch to **Ticket** to assign each line to whoever had it — useful for a shared table where not everyone ordered the same thing. Any difference between the lines and the total (tax, service, a tip) becomes a final *Tax & service* line so the split always adds up to what was actually paid.

## Choosing a model

Receipt scanning uses the provider configured for [AI Parsing](AI-Booking-Import#choosing-a-provider), either instance-wide by an admin or per user in [User Settings](User-Settings).

**A photo requires a vision-capable model.** The image is sent to the provider as-is; a text-only model will return nothing.

- **Anthropic** — reads photos and scanned PDFs natively.
- **OpenAI / OpenAI-compatible** — reads photos with a vision model (`gpt-4o` and similar).
- **Local (Ollama)** — needs a model that reads images. Admin → Addons offers one: **Qwen3.5 — 4B** (`qwen3.5:4b`, 3.4 GB, 256K context). It is multimodal, so the same download covers both jobs — booking imports and photographed receipts — and a self-hosted instance needs nothing else. Any other model can still be typed in or picked from what Ollama already has.

> **A text-only model is not enough.** `qwen3:8b` still handles booking imports and PDF invoices that carry a text layer, but a photo — or a photo saved as a PDF — fails with *"the configured AI model cannot read images"*. Admin → Addons warns when the selected model cannot read images.

TREK asks a self-hosted server to turn **reasoning off** for these calls, and strips a reasoning block from the answer if one arrives anyway. On a hybrid model like Qwen3.5 the chain of thought is most of the wall clock for an answer that is a dozen fields, and it lands in the same response as the JSON.

A PDF with no text layer behaves the same as a photo: it needs a vision provider.

## Privacy

The receipt is sent to whichever provider is configured — with a local model, nothing leaves your server. Photos are shrunk in the browser first, so what is uploaded is already only as large as the model needs. The uploaded bytes are held in memory only for the length of the review (30 minutes at most) so the file can be attached without re-uploading, and are dropped as soon as you save or the review expires. Nothing is written to the trip until you confirm.

## Troubleshooting

**No *Scan receipt* button** — the Costs addon, the AI Parsing addon, or both, are disabled. See [Admin-Addons](Admin-Addons).

**"Receipt scanning needs the AI parsing addon set up with a vision-capable model"** — the addon is on, but no provider/model is configured for you. Set one in [User Settings](User-Settings), or ask an admin to set an instance-wide one.

**"Nothing readable was found on this receipt"** — usually a text-only model given a photo. Switch to a vision model. Otherwise retake the photo: fill the frame with the receipt, flatten it, avoid glare on thermal paper, and crop tight in the step before the scan.

**"The AI model did not answer in time"** — a local model on a cold start can take minutes to load before it reads anything. Try again once it is resident; if it keeps happening, raise `LLM_TIMEOUT_MS` (see [Environment-Variables](Environment-Variables)).

**The total is wrong** — thermal receipts often print the subtotal and the total in the same style. Fix it in the review card; the amount you confirm is the one that is saved.

**The date is a few months off** — an ambiguous `05/06/2026` is read day-first. Correct it with the day picker in the review card.
